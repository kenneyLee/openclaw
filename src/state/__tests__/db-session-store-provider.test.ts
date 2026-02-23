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

  test("updateSessionStore performs load → mutate → save", async () => {
    const entry = { sessionId: "s1", updatedAt: 1000 };
    const { pool, executeFn } = createMockPool([
      { session_key: "alice", session_data: JSON.stringify(entry) },
    ]);
    const provider = new DatabaseSessionStoreProvider(pool);

    const result = await provider.updateSessionStore("/store/path", (store) => {
      store.alice.sessionId = "s1-updated";
      return "done";
    });

    expect(result).toBe("done");
    // First call = loadSessionStore SELECT, second+ = saveSessionStore transaction
    expect(executeFn).toHaveBeenCalled();
  });
});
