/**
 * Webhook Delivery
 *
 * Delivers agent results to tenant callback URLs with HMAC signature.
 */

import { createHmac } from "node:crypto";
import type { WebhookConfig } from "../state/types.js";

const DELIVERY_TIMEOUT_MS = 10_000;

export function signWebhookPayload(secret: string, body: string): string {
  const hmac = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hmac}`;
}

export function verifyWebhookSignature(secret: string, body: string, signature: string): boolean {
  const expected = signWebhookPayload(secret, body);
  if (expected.length !== signature.length) {
    return false;
  }
  // Constant-time comparison
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function deliverWebhookResult(params: {
  webhook: WebhookConfig;
  payload: {
    tenantId: string;
    user: string;
    message: string;
    runId: string;
    timestamp: number;
  };
  log?: { warn: (msg: string) => void };
}): Promise<{ ok: boolean; status?: number; error?: string }> {
  const body = JSON.stringify(params.payload);
  const signature = signWebhookPayload(params.webhook.signingSecret, body);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    const res = await fetch(params.webhook.callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OpenClaw-Signature": signature,
        "X-OpenClaw-Webhook-Id": params.webhook.webhookId,
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const msg = `webhook delivery failed: ${res.status} ${res.statusText}`;
      params.log?.warn(msg);
      return { ok: false, status: res.status, error: msg };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    const msg = `webhook delivery error: ${String(err)}`;
    params.log?.warn(msg);
    return { ok: false, error: msg };
  }
}
