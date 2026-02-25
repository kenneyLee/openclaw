/**
 * Admin Entity Memory HTTP Handler
 *
 * Endpoints for the Entity Memory platform primitive:
 *
 *   POST   /v1/admin/memory/ingest            — batch write: profile + episode + concerns + re-render
 *   POST   /v1/admin/memory/ingest-raw       — raw message extraction + ingest
 *   GET    /v1/admin/memory/context            — rendered MEMORY.md text
 *   GET    /v1/admin/memory/profile            — raw profile
 *   GET    /v1/admin/memory/concerns           — active concerns
 *   GET    /v1/admin/memory/concerns/all       — all concerns (including resolved)
 *   GET    /v1/admin/memory/episodes           — episodes by time range
 *   PUT    /v1/admin/memory/concerns/:key      — update concern status
 *   POST   /v1/admin/memory/render             — force re-render MEMORY.md
 *
 * All endpoints use gateway shared token auth.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, RowDataPacket } from "mysql2/promise";
import type { DatabaseEntityMemoryProvider } from "../state/db-entity-memory-provider.js";
import type { DatabaseStateProvider } from "../state/db-state-provider.js";
import {
  extractFromRawMessages,
  type ExtractionResult,
  type RawMessage,
} from "../state/memory-extraction.js";
import type { StateProvider } from "../state/types.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { authorizeGatewayBearerRequestOrReply } from "./http-auth-helpers.js";
import { readJsonBodyOrError, sendJson } from "./http-common.js";

type AdminEntityMemoryHttpOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  stateProvider?: StateProvider;
  jwtSecret?: string;
};

const MAX_BODY_BYTES = 256 * 1024;

// ── Helpers ─────────────────────────────────────────────────────────

function getPool(stateProvider: StateProvider): Pool | null {
  const provider = stateProvider as unknown as DatabaseStateProvider;
  if (provider.pool) {
    return provider.pool;
  }
  return null;
}

function getEntityMemory(provider: StateProvider | undefined): DatabaseEntityMemoryProvider | null {
  if (!provider?.entityMemory) {
    return null;
  }
  return provider.entityMemory as DatabaseEntityMemoryProvider;
}

function sendNotImplemented(res: ServerResponse) {
  sendJson(res, 501, {
    error: {
      message:
        "Entity Memory API requires database state backend. Set gateway.stateBackend to 'database'.",
      type: "not_implemented",
    },
  });
}

async function authorize(
  req: IncomingMessage,
  res: ServerResponse,
  opts: AdminEntityMemoryHttpOptions,
): Promise<boolean> {
  return authorizeGatewayBearerRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    jwtSecret: opts.jwtSecret,
  });
}

// ── Route patterns ──────────────────────────────────────────────────

const MEMORY_INGEST_PATH = "/v1/admin/memory/ingest";
const MEMORY_INGEST_RAW_PATH = "/v1/admin/memory/ingest-raw";
const MEMORY_CONTEXT_PATH = "/v1/admin/memory/context";
const MEMORY_PROFILE_PATH = "/v1/admin/memory/profile";
const MEMORY_CONCERNS_PATH = "/v1/admin/memory/concerns";
const MEMORY_CONCERNS_ALL_PATH = "/v1/admin/memory/concerns/all";
const MEMORY_EPISODES_PATH = "/v1/admin/memory/episodes";
const MEMORY_CONCERN_DETAIL_RE = /^\/v1\/admin\/memory\/concerns\/([^/]+)$/;
const MEMORY_RENDER_PATH = "/v1/admin/memory/render";

// ── Bootstrap file row ──────────────────────────────────────────────

interface BootstrapFileRow extends RowDataPacket {
  content: string;
}

// ── Main handler ────────────────────────────────────────────────────

export async function handleAdminEntityMemoryHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: AdminEntityMemoryHttpOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // ── POST /v1/admin/memory/ingest ──────────────────────────────

  if (pathname === MEMORY_INGEST_PATH && req.method === "POST") {
    if (!(await authorize(req, res, opts))) {
      return true;
    }
    const em = getEntityMemory(opts.stateProvider);
    if (!em) {
      sendNotImplemented(res);
      return true;
    }
    try {
      const body = (await readJsonBodyOrError(req, res, MAX_BODY_BYTES)) as {
        tenantId: string;
        profileUpdates?: Record<string, unknown>;
        episode?: {
          episodeType: string;
          channel: string;
          content: string;
          metadata?: Record<string, unknown>;
        };
        concerns?: Array<{
          concernKey: string;
          displayName: string;
          severity: "low" | "medium" | "high" | "critical";
          evidenceText: string;
          source: string;
        }>;
        render?: boolean;
      };
      if (!body) {
        return true;
      } // readJsonBodyOrError already replied
      if (!body.tenantId) {
        sendJson(res, 400, {
          error: { message: "tenantId is required", type: "invalid_request_error" },
        });
        return true;
      }

      // Delegate to transactional ingest — profile/episode/concerns/render
      // are wrapped in a single MySQL transaction to prevent partial writes.
      // medical_facts merge uses SELECT … FOR UPDATE to prevent data loss.
      const results = await em.ingest(body.tenantId, {
        profileUpdates: body.profileUpdates,
        episode: body.episode,
        concerns: body.concerns,
        render: body.render,
      });

      sendJson(res, 200, { ok: true, results });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: `Ingest failed: ${String(err)}`, type: "api_error" },
      });
    }
    return true;
  }

  // ── POST /v1/admin/memory/ingest-raw ────────────────────────────

  if (pathname === MEMORY_INGEST_RAW_PATH && req.method === "POST") {
    if (!(await authorize(req, res, opts))) {
      return true;
    }
    const em = getEntityMemory(opts.stateProvider);
    if (!em) {
      sendNotImplemented(res);
      return true;
    }
    try {
      const body = (await readJsonBodyOrError(req, res, MAX_BODY_BYTES)) as {
        tenantId: string;
        channel: string;
        messages: RawMessage[];
        source?: string;
        render?: boolean;
      };
      if (!body) {
        return true;
      }
      if (!body.tenantId) {
        sendJson(res, 400, {
          error: { message: "tenantId is required", type: "invalid_request_error" },
        });
        return true;
      }
      if (!body.channel) {
        sendJson(res, 400, {
          error: { message: "channel is required", type: "invalid_request_error" },
        });
        return true;
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        sendJson(res, 400, {
          error: { message: "messages must be a non-empty array", type: "invalid_request_error" },
        });
        return true;
      }

      // ── Per-message validation & size limits ──
      const MAX_MESSAGES = 200;
      const MAX_TOTAL_CHARS = 50_000;
      const VALID_ROLES = new Set(["parent", "caregiver", "system"]);

      if (body.messages.length > MAX_MESSAGES) {
        sendJson(res, 400, {
          error: {
            message: `messages exceeds maximum count (${MAX_MESSAGES})`,
            type: "invalid_request_error",
          },
        });
        return true;
      }

      let totalChars = 0;
      for (let i = 0; i < body.messages.length; i++) {
        const msg = body.messages[i];
        if (!msg || typeof msg !== "object") {
          sendJson(res, 400, {
            error: { message: `messages[${i}] is not an object`, type: "invalid_request_error" },
          });
          return true;
        }
        if (!VALID_ROLES.has(msg.role)) {
          sendJson(res, 400, {
            error: {
              message: `messages[${i}].role must be one of: parent, caregiver, system`,
              type: "invalid_request_error",
            },
          });
          return true;
        }
        if (!msg.content || typeof msg.content !== "string") {
          sendJson(res, 400, {
            error: {
              message: `messages[${i}].content must be a non-empty string`,
              type: "invalid_request_error",
            },
          });
          return true;
        }
        if (msg.timestamp !== undefined) {
          if (typeof msg.timestamp !== "string" || Number.isNaN(Date.parse(msg.timestamp))) {
            sendJson(res, 400, {
              error: {
                message: `messages[${i}].timestamp is not a valid ISO 8601 date`,
                type: "invalid_request_error",
              },
            });
            return true;
          }
        }
        totalChars += msg.content.length;
      }

      if (totalChars > MAX_TOTAL_CHARS) {
        sendJson(res, 400, {
          error: {
            message: `total message content exceeds ${MAX_TOTAL_CHARS} characters (got ${totalChars})`,
            type: "invalid_request_error",
          },
        });
        return true;
      }

      // ── Helper: build fallback content from raw messages ──
      const buildFallbackContent = () =>
        body.messages
          .map((m) => `[${m.role}] ${m.content}`)
          .join("\n")
          .slice(0, 5000);

      // Load existing profile for deduplication
      let existingProfile: Record<string, unknown> | null = null;
      try {
        const profile = await em.getProfile(body.tenantId);
        if (profile) {
          existingProfile = profile.profileData;
        }
      } catch {
        /* ignore — extraction can proceed without profile */
      }

      // LLM extraction
      let extraction: ExtractionResult;
      try {
        extraction = await extractFromRawMessages({
          messages: body.messages,
          channel: body.channel,
          existingProfile,
        });
      } catch (extractErr) {
        // Fallback: LLM call failed or returned invalid schema
        const fallbackResult = await em.ingest(body.tenantId, {
          episode: {
            episodeType: "conversation",
            channel: body.channel,
            content: buildFallbackContent(),
            metadata: { source: body.source ?? "ingest-raw", extractionFailed: true },
          },
          render: body.render !== false,
        });
        sendJson(res, 200, {
          ok: true,
          extractionFailed: true,
          extractionError: String(extractErr),
          results: fallbackResult,
        });
        return true;
      }

      // Use extraction results with existing ingest pipeline.
      // Schema validation in extractFromRawMessages already ensures data quality.
      // If ingest fails here, it's a DB/system error — let it propagate to 500.
      const ingestOpts: Parameters<typeof em.ingest>[1] = {
        episode: {
          episodeType: "conversation",
          channel: body.channel,
          content: extraction.episodeSummary,
          metadata: {
            source: body.source ?? "ingest-raw",
            rawMessageCount: body.messages.length,
          },
        },
        render: body.render !== false,
      };
      if (extraction.profileUpdates && Object.keys(extraction.profileUpdates).length > 0) {
        ingestOpts.profileUpdates = extraction.profileUpdates;
      }
      if (extraction.concerns && extraction.concerns.length > 0) {
        ingestOpts.concerns = extraction.concerns.map((c) => ({
          ...c,
          source: body.source ?? "ingest-raw",
        }));
      }

      const results = await em.ingest(body.tenantId, ingestOpts);
      sendJson(res, 200, { ok: true, extraction, results });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: `Ingest-raw failed: ${String(err)}`, type: "api_error" },
      });
    }
    return true;
  }

  // ── GET /v1/admin/memory/context?tenant_id=X ─────────────────

  if (pathname === MEMORY_CONTEXT_PATH && req.method === "GET") {
    if (!(await authorize(req, res, opts))) {
      return true;
    }
    const pool = opts.stateProvider ? getPool(opts.stateProvider) : null;
    if (!pool) {
      sendNotImplemented(res);
      return true;
    }
    try {
      const tenantId = url.searchParams.get("tenant_id");
      if (!tenantId) {
        sendJson(res, 400, {
          error: { message: "tenant_id query param is required", type: "invalid_request_error" },
        });
        return true;
      }

      const [rows] = await pool.execute<BootstrapFileRow[]>(
        `SELECT content FROM tenant_bootstrap_files
         WHERE tenant_id = ? AND file_name = 'MEMORY.md'`,
        [tenantId],
      );

      if (rows.length === 0) {
        sendJson(res, 200, { tenantId, content: "", found: false });
        return true;
      }
      sendJson(res, 200, { tenantId, content: rows[0].content, found: true });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: `Failed to read context: ${String(err)}`, type: "api_error" },
      });
    }
    return true;
  }

  // ── GET /v1/admin/memory/profile?tenant_id=X ─────────────────

  if (pathname === MEMORY_PROFILE_PATH && req.method === "GET") {
    if (!(await authorize(req, res, opts))) {
      return true;
    }
    const em = getEntityMemory(opts.stateProvider);
    if (!em) {
      sendNotImplemented(res);
      return true;
    }
    try {
      const tenantId = url.searchParams.get("tenant_id");
      if (!tenantId) {
        sendJson(res, 400, {
          error: { message: "tenant_id query param is required", type: "invalid_request_error" },
        });
        return true;
      }

      const profile = await em.getProfile(tenantId);
      if (!profile) {
        sendJson(res, 200, { tenantId, profile: null });
        return true;
      }
      sendJson(res, 200, { tenantId, profile });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: `Failed to read profile: ${String(err)}`, type: "api_error" },
      });
    }
    return true;
  }

  // ── GET /v1/admin/memory/concerns/all?tenant_id=X ──────────────

  if (pathname === MEMORY_CONCERNS_ALL_PATH && req.method === "GET") {
    if (!(await authorize(req, res, opts))) {
      return true;
    }
    const em = getEntityMemory(opts.stateProvider);
    if (!em) {
      sendNotImplemented(res);
      return true;
    }
    try {
      const tenantId = url.searchParams.get("tenant_id");
      if (!tenantId) {
        sendJson(res, 400, {
          error: { message: "tenant_id query param is required", type: "invalid_request_error" },
        });
        return true;
      }

      const concerns = await em.getAllConcerns(tenantId);
      sendJson(res, 200, { tenantId, concerns });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: `Failed to read concerns: ${String(err)}`, type: "api_error" },
      });
    }
    return true;
  }

  // ── GET /v1/admin/memory/episodes?tenant_id=X&days=14&limit=100 ─

  if (pathname === MEMORY_EPISODES_PATH && req.method === "GET") {
    if (!(await authorize(req, res, opts))) {
      return true;
    }
    const em = getEntityMemory(opts.stateProvider);
    if (!em) {
      sendNotImplemented(res);
      return true;
    }
    try {
      const tenantId = url.searchParams.get("tenant_id");
      if (!tenantId) {
        sendJson(res, 400, {
          error: { message: "tenant_id query param is required", type: "invalid_request_error" },
        });
        return true;
      }

      const daysParam = url.searchParams.get("days");
      const limitParam = url.searchParams.get("limit");
      const days = daysParam ? Number(daysParam) : 14;
      const limit = limitParam ? Number(limitParam) : 100;

      if (!Number.isInteger(days) || days < 1) {
        sendJson(res, 400, {
          error: { message: "days must be a positive integer", type: "invalid_request_error" },
        });
        return true;
      }

      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        sendJson(res, 400, {
          error: {
            message: "limit must be a positive integer (max 500)",
            type: "invalid_request_error",
          },
        });
        return true;
      }

      const since = new Date();
      since.setDate(since.getDate() - days);

      const episodes = await em.getEpisodesSince(tenantId, since, { limit });
      sendJson(res, 200, { tenantId, episodes });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: `Failed to read episodes: ${String(err)}`, type: "api_error" },
      });
    }
    return true;
  }

  // ── GET /v1/admin/memory/concerns?tenant_id=X ────────────────

  if (pathname === MEMORY_CONCERNS_PATH && req.method === "GET") {
    if (!(await authorize(req, res, opts))) {
      return true;
    }
    const em = getEntityMemory(opts.stateProvider);
    if (!em) {
      sendNotImplemented(res);
      return true;
    }
    try {
      const tenantId = url.searchParams.get("tenant_id");
      if (!tenantId) {
        sendJson(res, 400, {
          error: { message: "tenant_id query param is required", type: "invalid_request_error" },
        });
        return true;
      }

      const concerns = await em.getActiveConcerns(tenantId);
      sendJson(res, 200, { tenantId, concerns });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: `Failed to read concerns: ${String(err)}`, type: "api_error" },
      });
    }
    return true;
  }

  // ── PUT /v1/admin/memory/concerns/:key ────────────────────────

  const concernMatch = pathname.match(MEMORY_CONCERN_DETAIL_RE);
  if (concernMatch && req.method === "PUT") {
    if (!(await authorize(req, res, opts))) {
      return true;
    }
    const em = getEntityMemory(opts.stateProvider);
    if (!em) {
      sendNotImplemented(res);
      return true;
    }
    try {
      const concernKey = decodeURIComponent(concernMatch[1]);
      const body = (await readJsonBodyOrError(req, res, MAX_BODY_BYTES)) as {
        tenantId: string;
        status: "improving" | "resolved" | "escalated";
      };
      if (!body) {
        return true;
      }
      if (!body.tenantId || !body.status) {
        sendJson(res, 400, {
          error: {
            message: "tenantId and status are required",
            type: "invalid_request_error",
          },
        });
        return true;
      }
      const validStatuses = new Set(["improving", "resolved", "escalated"]);
      if (!validStatuses.has(body.status)) {
        sendJson(res, 400, {
          error: {
            message: "status must be one of: improving, resolved, escalated",
            type: "invalid_request_error",
          },
        });
        return true;
      }

      const result = await em.updateConcernStatus(body.tenantId, concernKey, body.status);
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: `Failed to update concern: ${String(err)}`, type: "api_error" },
      });
    }
    return true;
  }

  // ── POST /v1/admin/memory/render ──────────────────────────────

  if (pathname === MEMORY_RENDER_PATH && req.method === "POST") {
    if (!(await authorize(req, res, opts))) {
      return true;
    }
    const em = getEntityMemory(opts.stateProvider);
    if (!em) {
      sendNotImplemented(res);
      return true;
    }
    try {
      const body = (await readJsonBodyOrError(req, res, MAX_BODY_BYTES)) as {
        tenantId: string;
      };
      if (!body) {
        return true;
      }
      if (!body.tenantId) {
        sendJson(res, 400, {
          error: { message: "tenantId is required", type: "invalid_request_error" },
        });
        return true;
      }

      const result = await em.renderMemoryFile(body.tenantId);
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: `Failed to render: ${String(err)}`, type: "api_error" },
      });
    }
    return true;
  }

  // Not handled by this module
  return false;
}
