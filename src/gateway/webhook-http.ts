/**
 * Webhook HTTP Handler
 *
 * Inbound: POST /v1/webhooks/:tenantId/inbound — receives messages from
 * external systems, verifies HMAC signature, and dispatches to agentCommand.
 *
 * Admin: POST /v1/admin/webhooks — creates webhook configs (gateway-token auth).
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { logWarn } from "../logger.js";
import { defaultRuntime } from "../runtime.js";
import type { DatabaseWebhookProvider } from "../state/db-webhook-provider.js";
import type { StateProvider } from "../state/types.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { readJsonBodyOrError, sendJson, sendMethodNotAllowed } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import { deliverWebhookResult, verifyWebhookSignature } from "./webhook-delivery.js";

type WebhookHttpOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  stateProvider?: StateProvider;
};

const INBOUND_MAX_BODY_BYTES = 1024 * 1024; // 1 MB
const ADMIN_MAX_BODY_BYTES = 64 * 1024;

// ── Inbound endpoint ──────────────────────────────────────────────────

export async function handleWebhookInboundHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: WebhookHttpOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);

  // Match /v1/webhooks/:tenantId/inbound
  const match = url.pathname.match(/^\/v1\/webhooks\/([^/]+)\/inbound$/);
  if (!match) {
    return false;
  }
  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return true;
  }

  const tenantId = decodeURIComponent(match[1]);
  if (!opts.stateProvider?.webhooks) {
    sendJson(res, 501, {
      error: {
        message: "Webhook support requires database state backend.",
        type: "not_implemented",
      },
    });
    return true;
  }

  const webhook = await opts.stateProvider.webhooks.resolveWebhook(tenantId);
  if (!webhook) {
    sendJson(res, 404, {
      error: { message: "No active webhook for this tenant", type: "not_found" },
    });
    return true;
  }

  // Read raw body for signature verification
  const rawBody = await readJsonBodyOrError(req, res, INBOUND_MAX_BODY_BYTES);
  if (rawBody === undefined) {
    return true;
  }

  // Verify HMAC signature
  const signature = req.headers["x-openclaw-signature"];
  if (typeof signature === "string") {
    const bodyStr = JSON.stringify(rawBody);
    if (!verifyWebhookSignature(webhook.signingSecret, bodyStr, signature)) {
      sendJson(res, 401, {
        error: { message: "Invalid webhook signature", type: "unauthorized" },
      });
      return true;
    }
  } else {
    sendJson(res, 401, {
      error: { message: "Missing X-OpenClaw-Signature header", type: "unauthorized" },
    });
    return true;
  }

  const body = rawBody as Record<string, unknown>;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const user = typeof body.user === "string" ? body.user.trim() : "webhook-user";
  if (!message) {
    sendJson(res, 400, {
      error: { message: "message is required", type: "invalid_request_error" },
    });
    return true;
  }

  const runId = randomUUID();
  const sessionKey = `tenant:${tenantId}:agent:${webhook.agentId}:webhook-user:${user}`;

  // Respond immediately with accepted
  sendJson(res, 202, { ok: true, runId });

  // Run agent asynchronously and deliver result
  const deps = createDefaultDeps();
  void (async () => {
    try {
      const result = await agentCommand(
        {
          message,
          sessionKey,
          runId,
          deliver: false,
          messageChannel: "webhook",
          bestEffortDeliver: false,
          stateProvider: opts.stateProvider,
          tenantId,
        },
        defaultRuntime,
        deps,
      );

      const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
      const replyText =
        payloads
          ?.map((p) => p.text ?? "")
          .filter(Boolean)
          .join("\n\n") ?? "";

      if (replyText) {
        await deliverWebhookResult({
          webhook,
          payload: {
            tenantId,
            user,
            message: replyText,
            runId,
            timestamp: Date.now(),
          },
          log: { warn: logWarn },
        });
      }
    } catch (err) {
      logWarn(`webhook agent run failed: tenant=${tenantId} run=${runId} error=${String(err)}`);
    }
  })();

  return true;
}

// ── Admin endpoint ────────────────────────────────────────────────────

function isCreateWebhookCapable(
  provider: StateProvider | undefined,
): provider is StateProvider & { webhooks: DatabaseWebhookProvider } {
  return Boolean(
    provider?.webhooks &&
    "createWebhook" in provider.webhooks &&
    typeof (provider.webhooks as Record<string, unknown>).createWebhook === "function",
  );
}

export async function handleAdminWebhooksHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: WebhookHttpOptions,
): Promise<boolean> {
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/v1/admin/webhooks",
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: ADMIN_MAX_BODY_BYTES,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }

  if (!isCreateWebhookCapable(opts.stateProvider)) {
    sendJson(res, 501, {
      error: {
        message:
          "Webhook management requires database state backend. Set gateway.stateBackend to 'database'.",
        type: "not_implemented",
      },
    });
    return true;
  }

  const body = handled.body as Record<string, unknown>;
  const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : undefined;
  const callbackUrl = typeof body.callbackUrl === "string" ? body.callbackUrl.trim() : undefined;
  if (!tenantId) {
    sendJson(res, 400, {
      error: { message: "tenantId is required", type: "invalid_request_error" },
    });
    return true;
  }
  if (!callbackUrl) {
    sendJson(res, 400, {
      error: { message: "callbackUrl is required", type: "invalid_request_error" },
    });
    return true;
  }

  const agentId = typeof body.agentId === "string" ? body.agentId.trim() || undefined : undefined;

  try {
    const { webhookId, signingSecret } = await (
      opts.stateProvider.webhooks as DatabaseWebhookProvider
    ).createWebhook({
      tenantId,
      callbackUrl,
      agentId,
    });

    sendJson(res, 201, { webhookId, signingSecret });
  } catch (err) {
    sendJson(res, 500, {
      error: {
        message: `Failed to create webhook: ${String(err)}`,
        type: "api_error",
      },
    });
  }
  return true;
}
