import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyAdminJwt } from "./admin-jwt.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import { sendGatewayAuthFailure } from "./http-common.js";
import { getBearerToken } from "./http-utils.js";

export async function authorizeGatewayBearerRequestOrReply(params: {
  req: IncomingMessage;
  res: ServerResponse;
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  jwtSecret?: string;
}): Promise<boolean> {
  const token = getBearerToken(params.req);

  // When a JWT secret is configured and a bearer token is present,
  // try JWT verification first. On success, skip gateway token auth.
  if (params.jwtSecret && token) {
    const jwtResult = verifyAdminJwt(token, params.jwtSecret);
    if (jwtResult.ok) {
      return true;
    }
    // JWT verification failed — fall through to gateway token auth.
  }

  const authResult = await authorizeHttpGatewayConnect({
    auth: params.auth,
    connectAuth: token ? { token, password: token } : null,
    req: params.req,
    trustedProxies: params.trustedProxies,
    allowRealIpFallback: params.allowRealIpFallback,
    rateLimiter: params.rateLimiter,
  });
  if (!authResult.ok) {
    sendGatewayAuthFailure(params.res, authResult);
    return false;
  }
  return true;
}
