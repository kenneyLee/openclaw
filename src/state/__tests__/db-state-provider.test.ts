import { describe, expect, test, vi } from "vitest";
import { DatabaseRouteProvider } from "../db-route-provider.js";
import { DatabaseSessionStoreProvider } from "../db-session-store-provider.js";
import { createDatabaseStateProvider, DatabaseStateProvider } from "../db-state-provider.js";
import type { StateProvider } from "../types.js";

function createMockPool() {
  const executeFn = vi.fn().mockResolvedValue([[], []]);
  const pool = { execute: executeFn } as unknown as import("mysql2/promise").Pool;
  return { pool, executeFn };
}

describe("DatabaseStateProvider", () => {
  test("id is 'database'", () => {
    const { pool } = createMockPool();
    const provider = new DatabaseStateProvider(pool);
    expect(provider.id).toBe("database");
  });

  test("routing is a DatabaseRouteProvider instance", () => {
    const { pool } = createMockPool();
    const provider = new DatabaseStateProvider(pool);
    expect(provider.routing).toBeInstanceOf(DatabaseRouteProvider);
  });

  test("sessions is a DatabaseSessionStoreProvider instance", () => {
    const { pool } = createMockPool();
    const provider = new DatabaseStateProvider(pool);
    expect(provider.sessions).toBeInstanceOf(DatabaseSessionStoreProvider);
  });

  test("bootstrap is undefined", () => {
    const { pool } = createMockPool();
    const provider: StateProvider = new DatabaseStateProvider(pool);
    expect(provider.bootstrap).toBeUndefined();
  });

  test("createDatabaseStateProvider factory returns DatabaseStateProvider", () => {
    const { pool } = createMockPool();
    const provider = createDatabaseStateProvider(pool);
    expect(provider).toBeInstanceOf(DatabaseStateProvider);
    expect(provider.id).toBe("database");
  });

  test("routeMatchKey option is forwarded to DatabaseRouteProvider", async () => {
    const { pool, executeFn } = createMockPool();
    const provider = new DatabaseStateProvider(pool, { routeMatchKey: "guild.id" });

    await provider.routing.resolveAgentRoute({
      cfg: {},
      channel: "discord",
      peer: { kind: "channel", id: "chan-1" },
    });

    expect(executeFn).toHaveBeenCalledWith(expect.any(String), ["discord", "guild.id", "chan-1"]);
  });
});
