/**
 * Admin API HTTP Handler
 *
 * Provides extended admin CRUD endpoints beyond the original
 * admin-tenants-http / admin-routes-http / webhook-http handlers:
 *
 *   GET    /v1/admin/tenants              — list tenants
 *   GET    /v1/admin/tenants/:id          — tenant detail (with keys, routes, webhooks)
 *   PUT    /v1/admin/tenants/:id          — update tenant
 *   GET    /v1/admin/api-keys             — list API keys
 *   DELETE /v1/admin/api-keys/:id         — disable API key
 *   GET    /v1/admin/webhooks             — list webhooks
 *   DELETE /v1/admin/webhooks/:id         — delete webhook
 *   GET    /v1/admin/templates            — list templates
 *   POST   /v1/admin/templates            — create template
 *   GET    /v1/admin/templates/:id        — get template
 *   PUT    /v1/admin/templates/:id        — update template
 *   DELETE /v1/admin/templates/:id        — delete template
 *   GET    /v1/admin/bootstrap-files      — list bootstrap files
 *   PUT    /v1/admin/bootstrap-files/:tenantId/:fileName — edit bootstrap file
 *   POST   /v1/admin/render              — trigger render
 *   POST   /v1/admin/render/batch        — batch re-render
 *
 * All endpoints use gateway shared token auth.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, RowDataPacket } from "mysql2/promise";
import type { DatabaseApiKeyProvider } from "../state/db-api-key-provider.js";
import type { DatabaseRouteProvider } from "../state/db-route-provider.js";
import type { DatabaseStateProvider } from "../state/db-state-provider.js";
import type { DatabaseTenantProvider } from "../state/db-tenant-provider.js";
import type { DatabaseWebhookProvider } from "../state/db-webhook-provider.js";
import { RenderService } from "../state/render-service.js";
import { MustacheTemplateEngine } from "../state/template-engine.js";
import { TemplateStore } from "../state/template-store.js";
import type { StateProvider } from "../state/types.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { authorizeGatewayBearerRequestOrReply } from "./http-auth-helpers.js";
import { readJsonBodyOrError, sendJson, sendMethodNotAllowed } from "./http-common.js";

type AdminApiHttpOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  stateProvider?: StateProvider;
  jwtSecret?: string;
};

const MAX_BODY_BYTES = 256 * 1024;

// ── Helper: extract pool from DatabaseStateProvider ──────────────────

function getPool(stateProvider: StateProvider): Pool | null {
  const provider = stateProvider as unknown as DatabaseStateProvider;
  if (provider.pool) {
    return provider.pool;
  }
  return null;
}

// ── Capability checks ────────────────────────────────────────────────

function isDatabaseBackend(provider: StateProvider | undefined): provider is StateProvider & {
  tenants: DatabaseTenantProvider;
  apiKeys: DatabaseApiKeyProvider;
  webhooks: DatabaseWebhookProvider;
  routing: DatabaseRouteProvider;
} {
  return Boolean(
    provider?.tenants &&
    typeof (provider.tenants as unknown as Record<string, unknown>).list === "function",
  );
}

function sendNotImplemented(res: ServerResponse) {
  sendJson(res, 501, {
    error: {
      message: "Admin API requires database state backend. Set gateway.stateBackend to 'database'.",
      type: "not_implemented",
    },
  });
}

// ── Authorization helper ─────────────────────────────────────────────

async function authorize(
  req: IncomingMessage,
  res: ServerResponse,
  opts: AdminApiHttpOptions,
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

// ── Route patterns ───────────────────────────────────────────────────

const TENANTS_LIST_PATH = "/v1/admin/tenants";
const TENANT_DETAIL_RE = /^\/v1\/admin\/tenants\/([^/]+)$/;
const API_KEYS_PATH = "/v1/admin/api-keys";
const API_KEY_DELETE_RE = /^\/v1\/admin\/api-keys\/(\d+)$/;
const WEBHOOKS_LIST_PATH = "/v1/admin/webhooks";
const WEBHOOK_DELETE_RE = /^\/v1\/admin\/webhooks\/(\d+)$/;
const TEMPLATES_PATH = "/v1/admin/templates";
const TEMPLATE_DETAIL_RE = /^\/v1\/admin\/templates\/([^/]+)$/;
const BOOTSTRAP_FILES_PATH = "/v1/admin/bootstrap-files";
const BOOTSTRAP_FILE_EDIT_RE = /^\/v1\/admin\/bootstrap-files\/([^/]+)\/([^/]+)$/;
const RENDER_PATH = "/v1/admin/render";
const RENDER_BATCH_PATH = "/v1/admin/render/batch";

// ── Bootstrap file DB helpers ────────────────────────────────────────

interface BootstrapFileRow extends RowDataPacket {
  id: number;
  tenant_id: string;
  file_name: string;
  content: string;
  updated_at: string;
}

// ── Main handler ─────────────────────────────────────────────────────

export async function handleAdminApiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: AdminApiHttpOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // ── GET /v1/admin/tenants — list tenants ──────────────────────────
  if (pathname === TENANTS_LIST_PATH && req.method === "GET") {
    if (!(await authorize(req, res, opts))) {
      return true;
    }
    if (!isDatabaseBackend(opts.stateProvider)) {
      sendNotImplemented(res);
      return true;
    }
    try {
      const tenants = await (opts.stateProvider.tenants as DatabaseTenantProvider).list();
      sendJson(res, 200, { tenants });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: `Failed to list tenants: ${String(err)}`, type: "api_error" },
      });
    }
    return true;
  }

  // ── GET/PUT /v1/admin/tenants/:id — detail / update ───────────────
  const tenantMatch = pathname.match(TENANT_DETAIL_RE);
  if (tenantMatch) {
    const tenantId = decodeURIComponent(tenantMatch[1]);

    if (req.method === "GET") {
      if (!(await authorize(req, res, opts))) {
        return true;
      }
      if (!isDatabaseBackend(opts.stateProvider)) {
        sendNotImplemented(res);
        return true;
      }
      try {
        const tenant = await (opts.stateProvider.tenants as DatabaseTenantProvider).get(tenantId);
        if (!tenant) {
          sendJson(res, 404, {
            error: { message: "Tenant not found", type: "not_found" },
          });
          return true;
        }
        // Aggregate related data
        const [apiKeys, routes, webhooks] = await Promise.all([
          (opts.stateProvider.apiKeys as DatabaseApiKeyProvider).listApiKeys(tenantId),
          (opts.stateProvider.routing as DatabaseRouteProvider).listRoutes(tenantId),
          (opts.stateProvider.webhooks as DatabaseWebhookProvider).listWebhooks(tenantId),
        ]);
        sendJson(res, 200, { ...tenant, apiKeys, routes, webhooks });
      } catch (err) {
        sendJson(res, 500, {
          error: { message: `Failed to get tenant: ${String(err)}`, type: "api_error" },
        });
      }
      return true;
    }

    if (req.method === "PUT") {
      if (!(await authorize(req, res, opts))) {
        return true;
      }
      if (!isDatabaseBackend(opts.stateProvider)) {
        sendNotImplemented(res);
        return true;
      }
      const body = await readJsonBodyOrError(req, res, MAX_BODY_BYTES);
      if (body === undefined) {
        return true;
      }

      const b = body as Record<string, unknown>;
      try {
        await (opts.stateProvider.tenants as DatabaseTenantProvider).update(tenantId, {
          name: typeof b.name === "string" ? b.name : undefined,
          templateId:
            b.templateId === null
              ? null
              : typeof b.templateId === "string"
                ? b.templateId
                : undefined,
          templateData:
            b.templateData === null
              ? null
              : typeof b.templateData === "object"
                ? (b.templateData as Record<string, unknown>)
                : undefined,
          status: b.status === "active" || b.status === "suspended" ? b.status : undefined,
        });
        const updated = await (opts.stateProvider.tenants as DatabaseTenantProvider).get(tenantId);
        sendJson(res, 200, updated);
      } catch (err) {
        sendJson(res, 500, {
          error: { message: `Failed to update tenant: ${String(err)}`, type: "api_error" },
        });
      }
      return true;
    }

    sendMethodNotAllowed(res, "GET, PUT");
    return true;
  }

  // ── GET /v1/admin/api-keys — list ─────────────────────────────────
  if (pathname === API_KEYS_PATH && req.method === "GET") {
    if (!(await authorize(req, res, opts))) {
      return true;
    }
    if (!isDatabaseBackend(opts.stateProvider)) {
      sendNotImplemented(res);
      return true;
    }
    const tenantId = url.searchParams.get("tenant_id") || undefined;
    try {
      const apiKeys = await (opts.stateProvider.apiKeys as DatabaseApiKeyProvider).listApiKeys(
        tenantId,
      );
      sendJson(res, 200, { apiKeys });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: `Failed to list api keys: ${String(err)}`, type: "api_error" },
      });
    }
    return true;
  }

  // ── DELETE /v1/admin/api-keys/:id — disable ───────────────────────
  const apiKeyMatch = pathname.match(API_KEY_DELETE_RE);
  if (apiKeyMatch) {
    if (req.method !== "DELETE") {
      sendMethodNotAllowed(res, "DELETE");
      return true;
    }
    if (!(await authorize(req, res, opts))) {
      return true;
    }
    if (!isDatabaseBackend(opts.stateProvider)) {
      sendNotImplemented(res);
      return true;
    }
    const id = Number(apiKeyMatch[1]);
    try {
      const { updated } = await (
        opts.stateProvider.apiKeys as DatabaseApiKeyProvider
      ).disableApiKey(id);
      sendJson(res, 200, { ok: true, updated });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: `Failed to disable api key: ${String(err)}`, type: "api_error" },
      });
    }
    return true;
  }

  // ── GET /v1/admin/webhooks — list ─────────────────────────────────
  if (pathname === WEBHOOKS_LIST_PATH && req.method === "GET") {
    if (!(await authorize(req, res, opts))) {
      return true;
    }
    if (!isDatabaseBackend(opts.stateProvider)) {
      sendNotImplemented(res);
      return true;
    }
    const tenantId = url.searchParams.get("tenant_id") || undefined;
    try {
      const webhooks = await (opts.stateProvider.webhooks as DatabaseWebhookProvider).listWebhooks(
        tenantId,
      );
      sendJson(res, 200, { webhooks });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: `Failed to list webhooks: ${String(err)}`, type: "api_error" },
      });
    }
    return true;
  }

  // ── DELETE /v1/admin/webhooks/:id — delete ────────────────────────
  const webhookMatch = pathname.match(WEBHOOK_DELETE_RE);
  if (webhookMatch) {
    if (req.method !== "DELETE") {
      sendMethodNotAllowed(res, "DELETE");
      return true;
    }
    if (!(await authorize(req, res, opts))) {
      return true;
    }
    if (!isDatabaseBackend(opts.stateProvider)) {
      sendNotImplemented(res);
      return true;
    }
    const id = Number(webhookMatch[1]);
    try {
      const { deleted } = await (
        opts.stateProvider.webhooks as DatabaseWebhookProvider
      ).deleteWebhook(id);
      sendJson(res, 200, { ok: true, deleted });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: `Failed to delete webhook: ${String(err)}`, type: "api_error" },
      });
    }
    return true;
  }

  // ── Templates CRUD ────────────────────────────────────────────────

  // GET /v1/admin/templates — list
  if (pathname === TEMPLATES_PATH && req.method === "GET") {
    if (!(await authorize(req, res, opts))) {
      return true;
    }
    const pool = isDatabaseBackend(opts.stateProvider) ? getPool(opts.stateProvider) : null;
    if (!pool) {
      sendNotImplemented(res);
      return true;
    }
    try {
      const store = new TemplateStore(pool);
      const templates = await store.list();
      sendJson(res, 200, { templates });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: `Failed to list templates: ${String(err)}`, type: "api_error" },
      });
    }
    return true;
  }

  // POST /v1/admin/templates — create
  if (pathname === TEMPLATES_PATH && req.method === "POST") {
    if (!(await authorize(req, res, opts))) {
      return true;
    }
    const pool = isDatabaseBackend(opts.stateProvider) ? getPool(opts.stateProvider) : null;
    if (!pool) {
      sendNotImplemented(res);
      return true;
    }
    const body = await readJsonBodyOrError(req, res, MAX_BODY_BYTES);
    if (body === undefined) {
      return true;
    }

    const b = body as Record<string, unknown>;
    const id = typeof b.id === "string" ? b.id.trim() : undefined;
    const name = typeof b.name === "string" ? b.name.trim() : undefined;
    const template = typeof b.template === "string" ? b.template : undefined;
    if (!id || !name || !template) {
      sendJson(res, 400, {
        error: { message: "id, name, and template are required", type: "invalid_request_error" },
      });
      return true;
    }
    const schemaJson =
      typeof b.schemaJson === "object" && b.schemaJson !== null
        ? (b.schemaJson as Record<string, unknown>)
        : undefined;
    try {
      const store = new TemplateStore(pool);
      await store.create(id, name, template, schemaJson);
      const created = await store.get(id);
      sendJson(res, 201, created);
    } catch (err) {
      sendJson(res, 500, {
        error: { message: `Failed to create template: ${String(err)}`, type: "api_error" },
      });
    }
    return true;
  }

  // GET/PUT/DELETE /v1/admin/templates/:id
  const templateMatch = pathname.match(TEMPLATE_DETAIL_RE);
  if (templateMatch) {
    const templateId = decodeURIComponent(templateMatch[1]);
    if (!(await authorize(req, res, opts))) {
      return true;
    }
    const pool = isDatabaseBackend(opts.stateProvider) ? getPool(opts.stateProvider) : null;
    if (!pool) {
      sendNotImplemented(res);
      return true;
    }
    const store = new TemplateStore(pool);

    if (req.method === "GET") {
      try {
        const tpl = await store.get(templateId);
        if (!tpl) {
          sendJson(res, 404, {
            error: { message: "Template not found", type: "not_found" },
          });
          return true;
        }
        sendJson(res, 200, tpl);
      } catch (err) {
        sendJson(res, 500, {
          error: { message: `Failed to get template: ${String(err)}`, type: "api_error" },
        });
      }
      return true;
    }

    if (req.method === "PUT") {
      const body = await readJsonBodyOrError(req, res, MAX_BODY_BYTES);
      if (body === undefined) {
        return true;
      }

      const b = body as Record<string, unknown>;
      const template = typeof b.template === "string" ? b.template : undefined;
      if (!template) {
        sendJson(res, 400, {
          error: { message: "template is required", type: "invalid_request_error" },
        });
        return true;
      }
      try {
        await store.update(templateId, template);
        const updated = await store.get(templateId);
        sendJson(res, 200, updated);
      } catch (err) {
        sendJson(res, 500, {
          error: { message: `Failed to update template: ${String(err)}`, type: "api_error" },
        });
      }
      return true;
    }

    if (req.method === "DELETE") {
      try {
        await store.delete(templateId);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 500, {
          error: { message: `Failed to delete template: ${String(err)}`, type: "api_error" },
        });
      }
      return true;
    }

    sendMethodNotAllowed(res, "GET, PUT, DELETE");
    return true;
  }

  // ── Bootstrap files ───────────────────────────────────────────────

  // GET /v1/admin/bootstrap-files?tenant_id=x
  if (pathname === BOOTSTRAP_FILES_PATH && req.method === "GET") {
    if (!(await authorize(req, res, opts))) {
      return true;
    }
    const pool = isDatabaseBackend(opts.stateProvider) ? getPool(opts.stateProvider) : null;
    if (!pool) {
      sendNotImplemented(res);
      return true;
    }
    const tenantId = url.searchParams.get("tenant_id");
    if (!tenantId) {
      sendJson(res, 400, {
        error: { message: "tenant_id query parameter is required", type: "invalid_request_error" },
      });
      return true;
    }
    try {
      const [rows] = await pool.execute<BootstrapFileRow[]>(
        "SELECT id, tenant_id, file_name, content, updated_at FROM tenant_bootstrap_files WHERE tenant_id = ? ORDER BY file_name",
        [tenantId],
      );
      const files = rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        fileName: r.file_name,
        content: r.content,
        updatedAt: String(r.updated_at),
      }));
      sendJson(res, 200, { files });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: `Failed to list bootstrap files: ${String(err)}`, type: "api_error" },
      });
    }
    return true;
  }

  // PUT /v1/admin/bootstrap-files/:tenantId/:fileName
  const bootstrapMatch = pathname.match(BOOTSTRAP_FILE_EDIT_RE);
  if (bootstrapMatch) {
    if (req.method !== "PUT") {
      sendMethodNotAllowed(res, "PUT");
      return true;
    }
    if (!(await authorize(req, res, opts))) {
      return true;
    }
    const pool = isDatabaseBackend(opts.stateProvider) ? getPool(opts.stateProvider) : null;
    if (!pool) {
      sendNotImplemented(res);
      return true;
    }
    const tenantId = decodeURIComponent(bootstrapMatch[1]);
    const fileName = decodeURIComponent(bootstrapMatch[2]);

    const body = await readJsonBodyOrError(req, res, MAX_BODY_BYTES);
    if (body === undefined) {
      return true;
    }

    const b = body as Record<string, unknown>;
    const content = typeof b.content === "string" ? b.content : undefined;
    if (content === undefined) {
      sendJson(res, 400, {
        error: { message: "content is required", type: "invalid_request_error" },
      });
      return true;
    }
    try {
      await pool.execute(
        `INSERT INTO tenant_bootstrap_files (tenant_id, file_name, content)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE content = VALUES(content), updated_at = CURRENT_TIMESTAMP`,
        [tenantId, fileName, content],
      );
      sendJson(res, 200, { ok: true, tenantId, fileName });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: `Failed to update bootstrap file: ${String(err)}`, type: "api_error" },
      });
    }
    return true;
  }

  // ── Render ────────────────────────────────────────────────────────

  // POST /v1/admin/render — single tenant render
  if (pathname === RENDER_PATH && req.method === "POST") {
    if (!(await authorize(req, res, opts))) {
      return true;
    }
    const pool = isDatabaseBackend(opts.stateProvider) ? getPool(opts.stateProvider) : null;
    if (!pool) {
      sendNotImplemented(res);
      return true;
    }
    const body = await readJsonBodyOrError(req, res, MAX_BODY_BYTES);
    if (body === undefined) {
      return true;
    }

    const b = body as Record<string, unknown>;
    const tenantId = typeof b.tenantId === "string" ? b.tenantId.trim() : undefined;
    const templateId = typeof b.templateId === "string" ? b.templateId.trim() : undefined;
    const data =
      typeof b.data === "object" && b.data !== null ? (b.data as Record<string, unknown>) : {};
    if (!tenantId || !templateId) {
      sendJson(res, 400, {
        error: { message: "tenantId and templateId are required", type: "invalid_request_error" },
      });
      return true;
    }
    try {
      const store = new TemplateStore(pool);
      const engine = new MustacheTemplateEngine();
      const renderService = new RenderService(pool, store, engine);
      await renderService.renderTenant(tenantId, templateId, data);
      // Also update oc_tenants template association
      if (isDatabaseBackend(opts.stateProvider)) {
        await (opts.stateProvider.tenants as DatabaseTenantProvider).update(tenantId, {
          templateId,
          templateData: data,
        });
      }
      sendJson(res, 200, { ok: true, tenantId, templateId });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: `Failed to render: ${String(err)}`, type: "api_error" },
      });
    }
    return true;
  }

  // POST /v1/admin/render/batch — re-render all tenants of a template
  if (pathname === RENDER_BATCH_PATH && req.method === "POST") {
    if (!(await authorize(req, res, opts))) {
      return true;
    }
    const pool = isDatabaseBackend(opts.stateProvider) ? getPool(opts.stateProvider) : null;
    if (!pool) {
      sendNotImplemented(res);
      return true;
    }
    const body = await readJsonBodyOrError(req, res, MAX_BODY_BYTES);
    if (body === undefined) {
      return true;
    }

    const b = body as Record<string, unknown>;
    const templateId = typeof b.templateId === "string" ? b.templateId.trim() : undefined;
    if (!templateId) {
      sendJson(res, 400, {
        error: { message: "templateId is required", type: "invalid_request_error" },
      });
      return true;
    }
    try {
      const store = new TemplateStore(pool);
      const engine = new MustacheTemplateEngine();
      const renderService = new RenderService(pool, store, engine);
      const result = await renderService.reRenderByTemplate(templateId);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, {
        error: { message: `Failed to batch render: ${String(err)}`, type: "api_error" },
      });
    }
    return true;
  }

  return false;
}
