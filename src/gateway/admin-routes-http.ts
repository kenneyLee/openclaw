/**
 * Admin Routes HTTP Handler
 *
 * Provides CRUD for tenant_routes table:
 *   POST   /v1/admin/routes       — create a route
 *   GET    /v1/admin/routes       — list routes (optional ?tenant_id= filter)
 *   DELETE /v1/admin/routes/:id   — delete a route
 *
 * Protected by gateway shared token auth.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseRouteProvider } from "../state/db-route-provider.js";
import type { StateProvider } from "../state/types.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { authorizeGatewayBearerRequestOrReply } from "./http-auth-helpers.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";

type AdminRoutesHttpOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  stateProvider?: StateProvider;
};

const MAX_BODY_BYTES = 64 * 1024;
const ROUTES_PATH = "/v1/admin/routes";
const ROUTES_DELETE_RE = /^\/v1\/admin\/routes\/(\d+)$/;

function isRouteCrudCapable(
  provider: StateProvider | undefined,
): provider is StateProvider & { routing: DatabaseRouteProvider } {
  return Boolean(
    provider?.routing &&
    "createRoute" in provider.routing &&
    typeof (provider.routing as Record<string, unknown>).createRoute === "function",
  );
}

export async function handleAdminRoutesHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: AdminRoutesHttpOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);

  // ── POST /v1/admin/routes — create ────────────────────────────────────
  if (url.pathname === ROUTES_PATH && req.method === "POST") {
    const handled = await handleGatewayPostJsonEndpoint(req, res, {
      pathname: ROUTES_PATH,
      auth: opts.auth,
      trustedProxies: opts.trustedProxies,
      allowRealIpFallback: opts.allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
      maxBodyBytes: MAX_BODY_BYTES,
    });
    if (handled === false) {
      return false;
    }
    if (!handled) {
      return true;
    }

    if (!isRouteCrudCapable(opts.stateProvider)) {
      sendJson(res, 501, {
        error: {
          message:
            "Route management requires database state backend. Set gateway.stateBackend to 'database'.",
          type: "not_implemented",
        },
      });
      return true;
    }

    const body = handled.body as Record<string, unknown>;
    const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : undefined;
    const channel = typeof body.channel === "string" ? body.channel.trim() : undefined;
    const matchValue = typeof body.matchValue === "string" ? body.matchValue.trim() : undefined;
    const agentId = typeof body.agentId === "string" ? body.agentId.trim() : undefined;
    const matchKey = typeof body.matchKey === "string" ? body.matchKey.trim() : "peer.id";

    if (!tenantId) {
      sendJson(res, 400, {
        error: { message: "tenantId is required", type: "invalid_request_error" },
      });
      return true;
    }
    if (!channel) {
      sendJson(res, 400, {
        error: { message: "channel is required", type: "invalid_request_error" },
      });
      return true;
    }
    if (!matchValue) {
      sendJson(res, 400, {
        error: { message: "matchValue is required", type: "invalid_request_error" },
      });
      return true;
    }
    if (!agentId) {
      sendJson(res, 400, {
        error: { message: "agentId is required", type: "invalid_request_error" },
      });
      return true;
    }

    try {
      const { id } = await (opts.stateProvider.routing as DatabaseRouteProvider).createRoute({
        tenantId,
        channel,
        matchKey,
        matchValue,
        agentId,
      });
      sendJson(res, 201, { id, tenantId, channel, matchKey, matchValue, agentId });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: `Failed to create route: ${String(err)}`, type: "api_error" },
      });
    }
    return true;
  }

  // ── GET /v1/admin/routes — list ───────────────────────────────────────
  if (url.pathname === ROUTES_PATH && req.method === "GET") {
    const authorized = await authorizeGatewayBearerRequestOrReply({
      req,
      res,
      auth: opts.auth,
      trustedProxies: opts.trustedProxies,
      allowRealIpFallback: opts.allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
    });
    if (!authorized) {
      return true;
    }

    if (!isRouteCrudCapable(opts.stateProvider)) {
      sendJson(res, 501, {
        error: {
          message:
            "Route management requires database state backend. Set gateway.stateBackend to 'database'.",
          type: "not_implemented",
        },
      });
      return true;
    }

    const tenantIdFilter = url.searchParams.get("tenant_id") || undefined;
    try {
      const routes = await (opts.stateProvider.routing as DatabaseRouteProvider).listRoutes(
        tenantIdFilter,
      );
      sendJson(res, 200, { routes });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: `Failed to list routes: ${String(err)}`, type: "api_error" },
      });
    }
    return true;
  }

  // ── DELETE /v1/admin/routes/:id — delete ──────────────────────────────
  const deleteMatch = url.pathname.match(ROUTES_DELETE_RE);
  if (deleteMatch) {
    if (req.method !== "DELETE") {
      sendMethodNotAllowed(res, "DELETE");
      return true;
    }

    const authorized = await authorizeGatewayBearerRequestOrReply({
      req,
      res,
      auth: opts.auth,
      trustedProxies: opts.trustedProxies,
      allowRealIpFallback: opts.allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
    });
    if (!authorized) {
      return true;
    }

    if (!isRouteCrudCapable(opts.stateProvider)) {
      sendJson(res, 501, {
        error: {
          message:
            "Route management requires database state backend. Set gateway.stateBackend to 'database'.",
          type: "not_implemented",
        },
      });
      return true;
    }

    const routeId = Number(deleteMatch[1]);
    try {
      const { deleted } = await (opts.stateProvider.routing as DatabaseRouteProvider).deleteRoute(
        routeId,
      );
      sendJson(res, 200, { ok: true, deleted });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: `Failed to delete route: ${String(err)}`, type: "api_error" },
      });
    }
    return true;
  }

  return false;
}
