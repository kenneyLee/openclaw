import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { ResolveAgentRouteInput, ResolvedAgentRoute } from "../routing/resolve-route.js";
import { buildAgentSessionKey, resolveAgentRoute } from "../routing/resolve-route.js";
import { buildAgentMainSessionKey, DEFAULT_MAIN_KEY } from "../routing/session-key.js";
import type { RouteProvider } from "./types.js";

interface TenantRouteRow extends RowDataPacket {
  agent_id: string;
  tenant_id: string;
}

interface TenantRouteFullRow extends RowDataPacket {
  id: number;
  tenant_id: string;
  channel: string;
  match_key: string;
  match_value: string;
  agent_id: string;
  created_at: string;
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

  async createRoute(params: {
    tenantId: string;
    channel: string;
    matchKey: string;
    matchValue: string;
    agentId: string;
  }): Promise<{ id: number }> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      "INSERT INTO tenant_routes (tenant_id, channel, match_key, match_value, agent_id) VALUES (?, ?, ?, ?, ?)",
      [
        params.tenantId,
        params.channel.trim().toLowerCase(),
        params.matchKey,
        params.matchValue,
        params.agentId,
      ],
    );
    return { id: result.insertId };
  }

  async listRoutes(tenantId?: string): Promise<
    Array<{
      id: number;
      tenantId: string;
      channel: string;
      matchKey: string;
      matchValue: string;
      agentId: string;
      createdAt: string;
    }>
  > {
    const query = tenantId
      ? "SELECT id, tenant_id, channel, match_key, match_value, agent_id, created_at FROM tenant_routes WHERE tenant_id = ? ORDER BY id"
      : "SELECT id, tenant_id, channel, match_key, match_value, agent_id, created_at FROM tenant_routes ORDER BY id";
    const params = tenantId ? [tenantId] : [];
    const [rows] = await this.pool.execute<TenantRouteFullRow[]>(query, params);
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      channel: r.channel,
      matchKey: r.match_key,
      matchValue: r.match_value,
      agentId: r.agent_id,
      createdAt: String(r.created_at),
    }));
  }

  async deleteRoute(id: number): Promise<{ deleted: number }> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      "DELETE FROM tenant_routes WHERE id = ?",
      [id],
    );
    return { deleted: result.affectedRows };
  }
}
