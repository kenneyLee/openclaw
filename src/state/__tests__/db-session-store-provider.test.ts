import { describe, expect, test, vi } from "vitest";
import { DatabaseSessionStoreProvider } from "../db-session-store-provider.js";

function createMockPool(rows: Record<string, unknown>[] = []) {
  const executeFn = vi.fn().mockResolvedValue([rows, []]);
  const queryFn = vi.fn().mockResolvedValue([{}, []]);
  const beginTransactionFn = vi.fn().mockResolvedValue(undefined);
  const commitFn = vi.fn().mockResolvedValue(undefined);
  const rollbackFn = vi.fn().mockResolvedValue(undefined);
  const releaseFn = vi.fn();

  const conn = {
    beginTransaction: beginTransactionFn,
    execute: executeFn,
    query: queryFn,
    commit: commitFn,
    rollback: rollbackFn,
    release: releaseFn,
  };

  const getConnectionFn = vi.fn().mockResolvedValue(conn);

  const pool = {
    execute: executeFn,
    getConnection: getConnectionFn,
  } as unknown as import("mysql2/promise").Pool;

  return { pool, executeFn, queryFn, conn, getConnectionFn };
}

describe("DatabaseSessionStoreProvider", () => {
  test("loadSessionStore returns empty record when no rows", async () => {
    const { pool } = createMockPool([]);
    const provider = new DatabaseSessionStoreProvider(pool);

    const result = await provider.loadSessionStore("/agents/main/sessions.json");

    expect(result).toEqual({});
  });

  test("loadSessionStore returns correct Record structure", async () => {
    const entry = { sessionId: "s1", updatedAt: 1000 };
    const { pool } = createMockPool([
      { session_key: "alice", session_data: JSON.stringify(entry) },
      { session_key: "bob", session_data: JSON.stringify({ sessionId: "s2", updatedAt: 2000 }) },
    ]);
    const provider = new DatabaseSessionStoreProvider(pool);

    const result = await provider.loadSessionStore("/store/path");

    expect(Object.keys(result)).toEqual(["alice", "bob"]);
    expect(result.alice.sessionId).toBe("s1");
    expect(result.bob.sessionId).toBe("s2");
  });

  test("loadSessionStore handles pre-parsed JSON objects", async () => {
    // mysql2 may return JSON columns as already-parsed objects
    const entry = { sessionId: "s1", updatedAt: 1000 };
    const { pool } = createMockPool([{ session_key: "alice", session_data: entry }]);
    const provider = new DatabaseSessionStoreProvider(pool);

    const result = await provider.loadSessionStore("/store/path");
    expect(result.alice.sessionId).toBe("s1");
  });

  test("loadSessionStore passes correct SQL", async () => {
    const { pool, executeFn } = createMockPool([]);
    const provider = new DatabaseSessionStoreProvider(pool);

    await provider.loadSessionStore("/my/store");

    expect(executeFn).toHaveBeenCalledWith(
      "SELECT session_key, session_data FROM tenant_sessions WHERE store_path = ?",
      ["/my/store"],
    );
  });

  test("saveSessionStore deletes then inserts in transaction", async () => {
    const { pool, conn } = createMockPool();
    const provider = new DatabaseSessionStoreProvider(pool);

    await provider.saveSessionStore("/store/path", {
      alice: { sessionId: "s1", updatedAt: 1000 },
    });

    expect(conn.beginTransaction).toHaveBeenCalled();
    expect(conn.execute).toHaveBeenCalledWith("DELETE FROM tenant_sessions WHERE store_path = ?", [
      "/store/path",
    ]);
    expect(conn.query).toHaveBeenCalledWith(
      "INSERT INTO tenant_sessions (store_path, session_key, session_data) VALUES ?",
      [[["/store/path", "alice", JSON.stringify({ sessionId: "s1", updatedAt: 1000 })]]],
    );
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });

  test("saveSessionStore skips INSERT when store is empty", async () => {
    const { pool, conn } = createMockPool();
    const provider = new DatabaseSessionStoreProvider(pool);

    await provider.saveSessionStore("/store/path", {});

    expect(conn.execute).toHaveBeenCalledWith("DELETE FROM tenant_sessions WHERE store_path = ?", [
      "/store/path",
    ]);
    expect(conn.query).not.toHaveBeenCalled();
    expect(conn.commit).toHaveBeenCalled();
  });

  test("saveSessionStore rolls back on error", async () => {
    const { pool, conn } = createMockPool();
    conn.execute.mockRejectedValueOnce(new Error("db error"));
    const provider = new DatabaseSessionStoreProvider(pool);

    await expect(
      provider.saveSessionStore("/store/path", { a: { sessionId: "x", updatedAt: 0 } }),
    ).rejects.toThrow("db error");

    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });

  test("updateSessionStore only upserts changed entries", async () => {
    const alice = { sessionId: "s1", updatedAt: 1000 };
    const bob = { sessionId: "s2", updatedAt: 2000 };
    const { pool, executeFn } = createMockPool([
      { session_key: "alice", session_data: JSON.stringify(alice) },
      { session_key: "bob", session_data: JSON.stringify(bob) },
    ]);
    const provider = new DatabaseSessionStoreProvider(pool);

    const result = await provider.updateSessionStore("/store/path", (store) => {
      store.alice.sessionId = "s1-updated";
      // bob is unchanged
      return "done";
    });

    expect(result).toBe("done");

    // Call 0: loadSessionStore SELECT
    // Call 1: upsert alice only (bob unchanged, no upsert)
    const calls = executeFn.mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0][0]).toContain("SELECT");
    expect(calls[1][0]).toContain("ON DUPLICATE KEY UPDATE");
    expect(calls[1][1]).toEqual([
      "/store/path",
      "alice",
      JSON.stringify({ sessionId: "s1-updated", updatedAt: 1000 }),
    ]);
  });

  test("updateSessionStore skips write when nothing changed", async () => {
    const alice = { sessionId: "s1", updatedAt: 1000 };
    const { pool, executeFn } = createMockPool([
      { session_key: "alice", session_data: JSON.stringify(alice) },
    ]);
    const provider = new DatabaseSessionStoreProvider(pool);

    await provider.updateSessionStore("/store/path", (_store) => {
      // no mutation
    });

    // Only the initial SELECT, no upsert or delete
    expect(executeFn).toHaveBeenCalledTimes(1);
    expect(executeFn.mock.calls[0][0]).toContain("SELECT");
  });

  test("updateSessionStore handles new entries", async () => {
    const { pool, executeFn } = createMockPool([]);
    const provider = new DatabaseSessionStoreProvider(pool);

    await provider.updateSessionStore("/store/path", (store) => {
      store.newKey = { sessionId: "new", updatedAt: 999 };
    });

    // Call 0: SELECT, Call 1: upsert newKey
    expect(executeFn).toHaveBeenCalledTimes(2);
    expect(executeFn.mock.calls[1][0]).toContain("ON DUPLICATE KEY UPDATE");
    expect(executeFn.mock.calls[1][1][1]).toBe("newKey");
  });

  test("updateSessionStore handles deleted entries", async () => {
    const alice = { sessionId: "s1", updatedAt: 1000 };
    const bob = { sessionId: "s2", updatedAt: 2000 };
    const { pool, executeFn } = createMockPool([
      { session_key: "alice", session_data: JSON.stringify(alice) },
      { session_key: "bob", session_data: JSON.stringify(bob) },
    ]);
    const provider = new DatabaseSessionStoreProvider(pool);

    await provider.updateSessionStore("/store/path", (store) => {
      delete store.bob;
    });

    // Call 0: SELECT, Call 1: DELETE bob
    expect(executeFn).toHaveBeenCalledTimes(2);
    expect(executeFn.mock.calls[1][0]).toContain("DELETE");
    expect(executeFn.mock.calls[1][0]).toContain("session_key IN");
    expect(executeFn.mock.calls[1][1]).toEqual(["/store/path", "bob"]);
  });

  test("updateSessionStore handles mixed upsert and delete", async () => {
    const alice = { sessionId: "s1", updatedAt: 1000 };
    const bob = { sessionId: "s2", updatedAt: 2000 };
    const { pool, executeFn } = createMockPool([
      { session_key: "alice", session_data: JSON.stringify(alice) },
      { session_key: "bob", session_data: JSON.stringify(bob) },
    ]);
    const provider = new DatabaseSessionStoreProvider(pool);

    await provider.updateSessionStore("/store/path", (store) => {
      store.alice.sessionId = "s1-v2";
      delete store.bob;
      store.charlie = { sessionId: "s3", updatedAt: 3000 };
    });

    // Call 0: SELECT
    // Call 1: upsert alice
    // Call 2: upsert charlie
    // Call 3: delete bob
    expect(executeFn).toHaveBeenCalledTimes(4);
    expect(executeFn.mock.calls[1][0]).toContain("ON DUPLICATE KEY UPDATE");
    expect(executeFn.mock.calls[1][1][1]).toBe("alice");
    expect(executeFn.mock.calls[2][0]).toContain("ON DUPLICATE KEY UPDATE");
    expect(executeFn.mock.calls[2][1][1]).toBe("charlie");
    expect(executeFn.mock.calls[3][0]).toContain("DELETE");
    expect(executeFn.mock.calls[3][1]).toEqual(["/store/path", "bob"]);
  });
});
