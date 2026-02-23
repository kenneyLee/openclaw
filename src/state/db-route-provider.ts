import type { Pool, RowDataPacket } from "mysql2/promise";
import type { ResolveAgentRouteInput, ResolvedAgentRoute } from "../routing/resolve-route.js";
import { buildAgentSessionKey, resolveAgentRoute } from "../routing/resolve-route.js";
import { buildAgentMainSessionKey, DEFAULT_MAIN_KEY } from "../routing/session-key.js";
import type { RouteProvider } from "./types.js";

interface TenantRouteRow extends RowDataPacket {
  agent_id: string;
  tenant_id: string;
}

export class DatabaseRouteProvider implements RouteProvider {
  constructor(
    private pool: Pool,
    private opts?: { matchKey?: string },
  ) {}

  async resolveAgentRoute(input: ResolveAgentRouteInput): Promise<ResolvedAgentRoute> {
    const matchKey = this.opts?.matchKey ?? "peer.id";
    const matchValue = input.peer?.id ?? "";
    const channel = (input.channel ?? "").trim().toLowerCase();

    const [rows] = await this.pool.execute<TenantRouteRow[]>(
      "SELECT agent_id, tenant_id FROM tenant_routes WHERE channel = ? AND match_key = ? AND match_value = ? LIMIT 1",
      [channel, matchKey, matchValue],
    );

    if (rows.length > 0) {
      const { agent_id, tenant_id } = rows[0];
      const sessionKey = buildAgentSessionKey({
        agentId: agent_id,
        channel,
        peer: input.peer,
      });
      const mainSessionKey = buildAgentMainSessionKey({
        agentId: agent_id,
        mainKey: DEFAULT_MAIN_KEY,
      });
      return {
        agentId: agent_id,
        channel,
        accountId: tenant_id,
        tenantId: tenant_id,
        sessionKey,
        mainSessionKey,
        matchedBy: "database",
      };
    }

    // fallback: delegate to file-based routing
    return resolveAgentRoute(input);
  }
}
