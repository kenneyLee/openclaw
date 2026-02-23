/**
 * Channel Inbound HTTP Handler
 *
 * POST /v1/channels/:channelName/inbound — receives messages from external IM
 * systems (Easemob, etc.), resolves tenant + agent via DatabaseRouteProvider,
 * and dispatches to agentCommand.
 *
 * Auth: tenant API key (osk_ prefix).
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { loadConfig } from "../config/config.js";
import { logWarn } from "../logger.js";
import { defaultRuntime } from "../runtime.js";
import type { StateProvider } from "../state/types.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { getChannelAdapter, genericAdapter, type InboundMessage } from "./channel-adapter.js";
import { readJsonBodyOrError, sendJson, sendMethodNotAllowed } from "./http-common.js";
import { getBearerToken } from "./http-utils.js";
// Side-effect import: registers built-in adapters
import "./adapters/easemob-adapter.js";

type ChannelInboundHttpOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  stateProvider?: StateProvider;
};

const INBOUND_MAX_BODY_BYTES = 1024 * 1024; // 1 MB
const CHANNEL_NAME_RE = /^\/v1\/channels\/([a-z0-9][a-z0-9_-]{0,31})\/inbound$/;

export async function handleChannelInboundHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ChannelInboundHttpOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);

  // Match /v1/channels/:channelName/inbound
  const match = url.pathname.match(CHANNEL_NAME_RE);
  if (!match) {
    return false;
  }
  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return true;
  }

  const channelName = match[1];

  // ── Auth: require osk_ tenant API key ────────────────────────────────
  if (!opts.stateProvider?.apiKeys) {
    sendJson(res, 501, {
      error: {
        message: "Channel inbound requires database state backend.",
        type: "not_implemented",
      },
    });
    return true;
  }

  const token = getBearerToken(req);
  if (!token || !token.startsWith("osk_")) {
    sendJson(res, 401, {
      error: { message: "Tenant API key (osk_) required", type: "unauthorized" },
    });
    return true;
  }

  const resolved = await opts.stateProvider.apiKeys.resolveApiKey(token);
  if (!resolved) {
    sendJson(res, 401, {
      error: { message: "Invalid or expired API key", type: "unauthorized" },
    });
    return true;
  }
  const tenantId = resolved.tenantId;

  // ── Read body ────────────────────────────────────────────────────────
  const rawBody = await readJsonBodyOrError(req, res, INBOUND_MAX_BODY_BYTES);
  if (rawBody === undefined) {
    return true;
  }
  const body = rawBody as Record<string, unknown>;

  // ── Parse inbound via adapter ────────────────────────────────────────
  const adapter = getChannelAdapter(channelName) ?? genericAdapter;
  const inbound: InboundMessage | null = adapter.parseInbound(body);
  if (!inbound) {
    sendJson(res, 400, {
      error: { message: "Unable to parse inbound message", type: "invalid_request_error" },
    });
    return true;
  }

  // ── Route via DatabaseRouteProvider ──────────────────────────────────
  if (!opts.stateProvider.routing) {
    sendJson(res, 501, {
      error: {
        message: "Channel inbound requires routing provider (database state backend).",
        type: "not_implemented",
      },
    });
    return true;
  }

  const cfg = loadConfig();
  const route = await opts.stateProvider.routing.resolveAgentRoute({
    cfg,
    channel: channelName,
    peer: inbound.peer,
  });

  // ── Build session key + dispatch ─────────────────────────────────────
  const sessionKey = `tenant:${tenantId}:${route.sessionKey}`;
  const runId = randomUUID();
  const asyncMode = body.async === true;

  if (asyncMode) {
    // Respond immediately, run agent in background
    sendJson(res, 202, { ok: true, runId, tenantId, agentId: route.agentId });

    const deps = createDefaultDeps();
    void (async () => {
      try {
        await agentCommand(
          {
            message: inbound.message,
            sessionKey,
            runId,
            deliver: false,
            messageChannel: channelName,
            bestEffortDeliver: false,
            stateProvider: opts.stateProvider,
            tenantId,
          },
          defaultRuntime,
          deps,
        );
      } catch (err) {
        logWarn(
          `channel inbound agent run failed: tenant=${tenantId} channel=${channelName} run=${runId} error=${String(err)}`,
        );
      }
    })();
  } else {
    // Synchronous: run agent and return result
    const deps = createDefaultDeps();
    try {
      const result = await agentCommand(
        {
          message: inbound.message,
          sessionKey,
          runId,
          deliver: false,
          messageChannel: channelName,
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

      const response: Record<string, unknown> = {
        ok: true,
        runId,
        tenantId,
        agentId: route.agentId,
        message: replyText || null,
      };

      if (
        "formatOutbound" in adapter &&
        typeof adapter.formatOutbound === "function" &&
        replyText
      ) {
        response.channelPayload = adapter.formatOutbound(
          { text: replyText, runId, tenantId },
          inbound,
        );
      }

      sendJson(res, 200, response);
    } catch (err) {
      logWarn(
        `channel inbound agent run failed: tenant=${tenantId} channel=${channelName} run=${runId} error=${String(err)}`,
      );
      sendJson(res, 500, {
        error: {
          message: `Agent run failed: ${String(err)}`,
          type: "api_error",
        },
      });
    }
  }

  return true;
}
