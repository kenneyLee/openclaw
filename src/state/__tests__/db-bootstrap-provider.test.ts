import { describe, expect, test, vi } from "vitest";
import { DatabaseBootstrapProvider } from "../db-bootstrap-provider.js";

function createMockPool(rows: Record<string, unknown>[] = []) {
  const executeFn = vi.fn().mockResolvedValue([rows, []]);
  const pool = { execute: executeFn } as unknown as import("mysql2/promise").Pool;
  return { pool, executeFn };
}

describe("DatabaseBootstrapProvider", () => {
  test("loadBootstrapFiles returns files from DB for given tenantId", async () => {
    const { pool, executeFn } = createMockPool([
      { file_name: "SOUL.md", content: "You are a helpful assistant." },
      { file_name: "AGENTS.md", content: "agent: default" },
    ]);
    const provider = new DatabaseBootstrapProvider(pool);

    const result = await provider.loadBootstrapFiles({ tenantId: "tenant-001" });

    expect(executeFn).toHaveBeenCalledWith(
      "SELECT file_name, content FROM tenant_bootstrap_files WHERE tenant_id = ?",
      ["tenant-001"],
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      name: "SOUL.md",
      path: "db://tenant-001/SOUL.md",
      content: "You are a helpful assistant.",
      missing: false,
    });
    expect(result[1]).toEqual({
      name: "AGENTS.md",
      path: "db://tenant-001/AGENTS.md",
      content: "agent: default",
      missing: false,
    });
  });

  test("loadBootstrapFiles returns empty array when DB has no data", async () => {
    const { pool } = createMockPool([]);
    const provider = new DatabaseBootstrapProvider(pool);

    const result = await provider.loadBootstrapFiles({ tenantId: "tenant-empty" });

    expect(result).toEqual([]);
  });

  test("loadBootstrapFiles throws when neither tenantId nor agentId provided", async () => {
    const { pool } = createMockPool([]);
    const provider = new DatabaseBootstrapProvider(pool);

    await expect(provider.loadBootstrapFiles({})).rejects.toThrow(
      "DatabaseBootstrapProvider requires tenantId or agentId",
    );
  });

  test("loadBootstrapFiles falls back to agentId when tenantId is missing", async () => {
    const { pool, executeFn } = createMockPool([{ file_name: "SOUL.md", content: "soul content" }]);
    const provider = new DatabaseBootstrapProvider(pool);

    const result = await provider.loadBootstrapFiles({ agentId: "agent-abc" });

    expect(executeFn).toHaveBeenCalledWith(expect.any(String), ["agent-abc"]);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("db://agent-abc/SOUL.md");
  });

  test("loadExtraBootstrapFiles always returns empty array", async () => {
    const { pool } = createMockPool([]);
    const provider = new DatabaseBootstrapProvider(pool);

    const result = await provider.loadExtraBootstrapFiles({ tenantId: "tenant-001" }, [
      "*.md",
      "config/**",
    ]);

    expect(result).toEqual([]);
  });

  test("path uses db:// virtual path scheme", async () => {
    const { pool } = createMockPool([{ file_name: "IDENTITY.md", content: "id content" }]);
    const provider = new DatabaseBootstrapProvider(pool);

    const result = await provider.loadBootstrapFiles({ tenantId: "t-99" });

    expect(result[0].path).toBe("db://t-99/IDENTITY.md");
  });
});
