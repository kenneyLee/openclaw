/**
 * Admin Auth HTTP Handler
 *
 * Public:    POST /v1/admin/auth/login  — username+password → JWT
 * Protected: GET  /v1/admin/auth/me     — verify JWT, return user info
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "mysql2/promise";
import { DatabaseAdminUserProvider, verifyPassword } from "../state/db-admin-user-provider.js";
import type { DatabaseStateProvider } from "../state/db-state-provider.js";
import type { StateProvider } from "../state/types.js";
import { createAdminJwt, verifyAdminJwt } from "./admin-jwt.js";
import {
  readJsonBodyOrError,
  sendJson,
  sendMethodNotAllowed,
  sendUnauthorized,
} from "./http-common.js";
import { getBearerToken } from "./http-utils.js";

type AdminAuthHttpOptions = {
  jwtSecret?: string;
  stateProvider?: StateProvider;
};

const MAX_BODY_BYTES = 16 * 1024;
const LOGIN_PATH = "/v1/admin/auth/login";
const ME_PATH = "/v1/admin/auth/me";

function getPool(stateProvider: StateProvider | undefined): Pool | null {
  const provider = stateProvider as unknown as DatabaseStateProvider;
  if (provider?.pool) {
    return provider.pool;
  }
  return null;
}

export async function handleAdminAuthHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: AdminAuthHttpOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // ── POST /v1/admin/auth/login ──────────────────────────────────────
  if (pathname === LOGIN_PATH) {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res);
      return true;
    }

    if (!opts.jwtSecret) {
      sendJson(res, 501, {
        error: {
          message: "Admin user authentication is not configured. Set OPENCLAW_ADMIN_JWT_SECRET.",
          type: "not_implemented",
        },
      });
      return true;
    }

    const pool = getPool(opts.stateProvider);
    if (!pool) {
      sendJson(res, 501, {
        error: {
          message: "Admin auth requires database state backend.",
          type: "not_implemented",
        },
      });
      return true;
    }

    const body = await readJsonBodyOrError(req, res, MAX_BODY_BYTES);
    if (body === undefined) {
      return true;
    }

    const b = body as Record<string, unknown>;
    const username = typeof b.username === "string" ? b.username.trim() : "";
    const password = typeof b.password === "string" ? b.password : "";

    if (!username || !password) {
      sendJson(res, 400, {
        error: { message: "username and password are required", type: "invalid_request_error" },
      });
      return true;
    }

    const provider = new DatabaseAdminUserProvider(pool);
    const user = await provider.getByUsername(username);

    if (!user || !user.isActive) {
      sendUnauthorized(res);
      return true;
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      sendUnauthorized(res);
      return true;
    }

    const token = createAdminJwt({
      userId: user.id,
      username: user.username,
      secret: opts.jwtSecret,
    });

    sendJson(res, 200, {
      token,
      user: { id: user.id, username: user.username },
    });
    return true;
  }

  // ── GET /v1/admin/auth/me ──────────────────────────────────────────
  if (pathname === ME_PATH) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }

    if (!opts.jwtSecret) {
      sendJson(res, 501, {
        error: {
          message: "Admin user authentication is not configured. Set OPENCLAW_ADMIN_JWT_SECRET.",
          type: "not_implemented",
        },
      });
      return true;
    }

    const token = getBearerToken(req);
    if (!token) {
      sendUnauthorized(res);
      return true;
    }

    const result = verifyAdminJwt(token, opts.jwtSecret);
    if (!result.ok) {
      sendUnauthorized(res);
      return true;
    }

    sendJson(res, 200, {
      user: { id: result.payload.sub, username: result.payload.username },
    });
    return true;
  }

  return false;
}
