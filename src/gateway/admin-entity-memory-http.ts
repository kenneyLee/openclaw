/**
 * Admin Entity Memory HTTP Handler
 *
 * Endpoints for the Entity Memory platform primitive:
 *
 *   POST   /v1/admin/memory/ingest            — batch write: profile + episode + concerns + re-render
 *   GET    /v1/admin/memory/context            — rendered MEMORY.md text
 *   GET    /v1/admin/memory/profile            — raw profile
 *   GET    /v1/admin/memory/concerns           — active concerns
 *   PUT    /v1/admin/memory/concerns/:key      — update concern status
 *   POST   /v1/admin/memory/render             — force re-render MEMORY.md
 *
 * All endpoints use gateway shared token auth.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, RowDataPacket } from "mysql2/promise";
import type { DatabaseEntityMemoryProvider } from "../state/db-entity-memory-provider.js";
import type { DatabaseStateProvider } from "../state/db-state-provider.js";
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
const MEMORY_CONTEXT_PATH = "/v1/admin/memory/context";
const MEMORY_PROFILE_PATH = "/v1/admin/memory/profile";
const MEMORY_CONCERNS_PATH = "/v1/admin/memory/concerns";
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
