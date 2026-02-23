/**
 * Admin Tenants HTTP Handler
 *
 * Provides `POST /v1/admin/tenants` for creating new tenants with API keys.
 * Protected by gateway shared token auth.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseApiKeyProvider } from "../state/db-api-key-provider.js";
import type { StateProvider } from "../state/types.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";

type AdminTenantsHttpOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  stateProvider?: StateProvider;
};

const MAX_BODY_BYTES = 64 * 1024;

function isCreateApiKeyCapable(provider: StateProvider | undefined): provider is StateProvider & {
  apiKeys: DatabaseApiKeyProvider;
} {
  return Boolean(
    provider?.apiKeys &&
    "createApiKey" in provider.apiKeys &&
    typeof (provider.apiKeys as Record<string, unknown>).createApiKey === "function",
  );
}

export async function handleAdminTenantsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: AdminTenantsHttpOptions,
): Promise<boolean> {
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/v1/admin/tenants",
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

  if (!isCreateApiKeyCapable(opts.stateProvider)) {
    sendJson(res, 501, {
      error: {
        message:
          "Tenant management requires database state backend. Set gateway.stateBackend to 'database'.",
        type: "not_implemented",
      },
    });
    return true;
  }

  const body = handled.body as Record<string, unknown>;
  const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : undefined;
  if (!tenantId) {
    sendJson(res, 400, {
      error: { message: "tenantId is required", type: "invalid_request_error" },
    });
    return true;
  }

  const label = typeof body.label === "string" ? body.label.trim() || undefined : undefined;
  const scopes = Array.isArray(body.scopes) ? (body.scopes as string[]) : null;

  try {
    const { apiKey } = await (opts.stateProvider.apiKeys as DatabaseApiKeyProvider).createApiKey({
      tenantId,
      label,
      scopes,
    });

    sendJson(res, 201, {
      tenantId,
      apiKey,
    });
  } catch (err) {
    sendJson(res, 500, {
      error: {
        message: `Failed to create tenant: ${String(err)}`,
        type: "api_error",
      },
    });
  }
  return true;
}
