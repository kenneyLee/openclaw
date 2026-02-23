import { describe, expect, test, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { DatabaseRouteProvider } from "../db-route-provider.js";

function createMockPool(rows: Record<string, unknown>[] = []) {
  const executeFn = vi.fn().mockResolvedValue([rows, []]);
  const pool = { execute: executeFn } as unknown as import("mysql2/promise").Pool;
  return { pool, executeFn };
}

describe("DatabaseRouteProvider", () => {
  const baseCfg: OpenClawConfig = {};

  test("returns database route when tenant_routes row exists", async () => {
    const { pool, executeFn } = createMockPool([
      { agent_id: "family-agent", tenant_id: "tenant-001" },
    ]);
    const provider = new DatabaseRouteProvider(pool);

    const result = await provider.resolveAgentRoute({
      cfg: baseCfg,
      channel: "wechat",
      peer: { kind: "group", id: "group-123" },
    });

    expect(result.agentId).toBe("family-agent");
    expect(result.accountId).toBe("tenant-001");
    expect(result.channel).toBe("wechat");
    expect(result.matchedBy).toBe("database");
    expect(result.sessionKey).toContain("agent:family-agent:");
    expect(result.mainSessionKey).toBe("agent:family-agent:main");

    expect(executeFn).toHaveBeenCalledWith(
      "SELECT agent_id, tenant_id FROM tenant_routes WHERE channel = ? AND match_key = ? AND match_value = ? LIMIT 1",
      ["wechat", "peer.id", "group-123"],
    );
  });

  test("falls back to file-based routing when no row found", async () => {
    const { pool } = createMockPool([]);
    const provider = new DatabaseRouteProvider(pool);

    const result = await provider.resolveAgentRoute({
      cfg: baseCfg,
      channel: "telegram",
      peer: { kind: "direct", id: "user-456" },
    });

    expect(result.agentId).toBe("main");
    expect(result.matchedBy).toBe("default");
  });

  test("custom matchKey is passed in query", async () => {
    const { pool, executeFn } = createMockPool([]);
    const provider = new DatabaseRouteProvider(pool, { matchKey: "guild.id" });

    await provider.resolveAgentRoute({
      cfg: baseCfg,
      channel: "discord",
      peer: { kind: "channel", id: "chan-789" },
    });

    expect(executeFn).toHaveBeenCalledWith(expect.any(String), ["discord", "guild.id", "chan-789"]);
  });

  test("handles missing peer gracefully", async () => {
    const { pool, executeFn } = createMockPool([]);
    const provider = new DatabaseRouteProvider(pool);

    const result = await provider.resolveAgentRoute({
      cfg: baseCfg,
      channel: "slack",
    });

    expect(executeFn).toHaveBeenCalledWith(expect.any(String), ["slack", "peer.id", ""]);
    expect(result.matchedBy).toBe("default");
  });

  test("falls back to file-based binding when db has no match but config has binding", async () => {
    const { pool } = createMockPool([]);
    const provider = new DatabaseRouteProvider(pool);

    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "file-agent",
          match: {
            channel: "whatsapp",
            peer: { kind: "direct", id: "+1000" },
          },
        },
      ],
    };

    const result = await provider.resolveAgentRoute({
      cfg,
      channel: "whatsapp",
      peer: { kind: "direct", id: "+1000" },
    });

    expect(result.agentId).toBe("file-agent");
    expect(result.matchedBy).toBe("binding.peer");
  });
});
