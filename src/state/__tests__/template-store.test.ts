import { describe, expect, test, vi } from "vitest";
import { TemplateStore } from "../template-store.js";

function createMockPool(rows: Record<string, unknown>[] = []) {
  const executeFn = vi.fn().mockResolvedValue([rows, []]);
  const pool = { execute: executeFn } as unknown as import("mysql2/promise").Pool;
  return { pool, executeFn };
}

describe("TemplateStore", () => {
  test("create inserts a template row", async () => {
    const { pool, executeFn } = createMockPool();
    const store = new TemplateStore(pool);

    await store.create("tpl-1", "Default SOUL", "Hello {{name}}", { name: "string" });

    expect(executeFn).toHaveBeenCalledWith(
      "INSERT INTO oc_templates (id, name, template, schema_json) VALUES (?, ?, ?, ?)",
      ["tpl-1", "Default SOUL", "Hello {{name}}", JSON.stringify({ name: "string" })],
    );
  });

  test("create passes null when schema is omitted", async () => {
    const { pool, executeFn } = createMockPool();
    const store = new TemplateStore(pool);

    await store.create("tpl-2", "No Schema", "Hello");

    expect(executeFn).toHaveBeenCalledWith(expect.any(String), [
      "tpl-2",
      "No Schema",
      "Hello",
      null,
    ]);
  });

  test("get returns template when found", async () => {
    const now = new Date();
    const { pool } = createMockPool([
      {
        id: "tpl-1",
        name: "Default SOUL",
        template: "Hello {{name}}",
        schema_json: { name: "string" },
        created_at: now,
        updated_at: now,
      },
    ]);
    const store = new TemplateStore(pool);

    const result = await store.get("tpl-1");

    expect(result).toEqual({
      id: "tpl-1",
      name: "Default SOUL",
      template: "Hello {{name}}",
      schema_json: { name: "string" },
      created_at: now,
      updated_at: now,
    });
  });

  test("get returns null when not found", async () => {
    const { pool } = createMockPool([]);
    const store = new TemplateStore(pool);

    const result = await store.get("nonexistent");

    expect(result).toBeNull();
  });

  test("list returns all templates", async () => {
    const now = new Date();
    const { pool } = createMockPool([
      {
        id: "tpl-1",
        name: "A",
        template: "a",
        schema_json: null,
        created_at: now,
        updated_at: now,
      },
      {
        id: "tpl-2",
        name: "B",
        template: "b",
        schema_json: null,
        created_at: now,
        updated_at: now,
      },
    ]);
    const store = new TemplateStore(pool);

    const result = await store.list();

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("tpl-1");
    expect(result[1].id).toBe("tpl-2");
  });

  test("update sends correct SQL", async () => {
    const { pool, executeFn } = createMockPool();
    const store = new TemplateStore(pool);

    await store.update("tpl-1", "Updated {{content}}");

    expect(executeFn).toHaveBeenCalledWith("UPDATE oc_templates SET template = ? WHERE id = ?", [
      "Updated {{content}}",
      "tpl-1",
    ]);
  });

  test("delete sends correct SQL", async () => {
    const { pool, executeFn } = createMockPool();
    const store = new TemplateStore(pool);

    await store.delete("tpl-1");

    expect(executeFn).toHaveBeenCalledWith("DELETE FROM oc_templates WHERE id = ?", ["tpl-1"]);
  });

  test("findTenantsByTemplate returns associated tenants", async () => {
    const { pool } = createMockPool([
      { tenant_id: "t-1", template_data: { name: "Baby A" } },
      { tenant_id: "t-2", template_data: { name: "Baby B" } },
    ]);
    const store = new TemplateStore(pool);

    const result = await store.findTenantsByTemplate("tpl-1");

    expect(result).toEqual([
      { tenant_id: "t-1", template_data: { name: "Baby A" } },
      { tenant_id: "t-2", template_data: { name: "Baby B" } },
    ]);
  });
});
