/**
 * Admin JWT — lightweight HMAC-SHA256 JWT for admin panel authentication.
 *
 * Uses only `node:crypto`; no external dependencies.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

// ── Helpers ──────────────────────────────────────────────────────────

function base64url(input: string | Buffer): string {
  const b = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return b.toString("base64url");
}

function base64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

// ── Create ───────────────────────────────────────────────────────────

const JWT_HEADER = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const DEFAULT_EXPIRY_SECONDS = 24 * 60 * 60; // 24 hours

export function createAdminJwt(params: {
  userId: number;
  username: string;
  secret: string;
  expirySeconds?: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: params.userId,
    username: params.username,
    iat: now,
    exp: now + (params.expirySeconds ?? DEFAULT_EXPIRY_SECONDS),
  };
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${JWT_HEADER}.${encodedPayload}`;
  const signature = createHmac("sha256", params.secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

// ── Verify ───────────────────────────────────────────────────────────

export type AdminJwtPayload = {
  sub: number;
  username: string;
  iat: number;
  exp: number;
};

type VerifyOk = { ok: true; payload: AdminJwtPayload };
type VerifyFail = { ok: false; reason: string };
export type VerifyResult = VerifyOk | VerifyFail;

export function verifyAdminJwt(token: string, secret: string): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "malformed token" };
  }
  const [header, payload, signature] = parts;

  // Recompute signature and compare with timing-safe equality.
  const signingInput = `${header}.${payload}`;
  const expected = createHmac("sha256", secret).update(signingInput).digest();
  let actual: Buffer;
  try {
    actual = base64urlDecode(signature);
  } catch {
    return { ok: false, reason: "invalid signature encoding" };
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: "signature mismatch" };
  }

  // Decode payload.
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(base64urlDecode(payload).toString("utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "invalid payload" };
  }

  const exp = typeof parsed.exp === "number" ? parsed.exp : 0;
  if (exp <= Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "token expired" };
  }

  return {
    ok: true,
    payload: {
      sub: parsed.sub as number,
      username: parsed.username as string,
      iat: parsed.iat as number,
      exp,
    },
  };
}
