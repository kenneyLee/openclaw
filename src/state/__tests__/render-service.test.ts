import { describe, expect, test, vi } from "vitest";
import { RenderService } from "../render-service.js";
import type { TemplateEngine } from "../template-engine.js";
import type { TemplateStore } from "../template-store.js";

function createMockPool() {
  const executeFn = vi.fn().mockResolvedValue([[], []]);
  const pool = { execute: executeFn } as unknown as import("mysql2/promise").Pool;
  return { pool, executeFn };
}

function createMockStore(overrides: Partial<TemplateStore> = {}): TemplateStore {
  return {
    create: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
    delete: vi.fn(),
    findTenantsByTemplate: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as TemplateStore;
}

function createMockEngine(overrides: Partial<TemplateEngine> = {}): TemplateEngine {
  return {
    render: vi.fn().mockReturnValue("rendered content"),
    validate: vi.fn().mockReturnValue({ valid: true, errors: [] }),
    ...overrides,
  };
}

describe("RenderService", () => {
  test("renderTenant fetches template, renders, and writes to DB", async () => {
    const { pool, executeFn } = createMockPool();
    const getFn = vi.fn().mockResolvedValue({
      id: "tpl-1",
      name: "SOUL",
      template: "Hello {{name}}, age {{months}} months",
      schema_json: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    const store = createMockStore({ get: getFn });
    const renderFn = vi.fn().mockReturnValue("Hello Mia, age 3 months");
    const engine = createMockEngine({ render: renderFn });

    const service = new RenderService(pool, store, engine);
    await service.renderTenant("tenant-001", "tpl-1", { name: "Mia", months: 3 });

    expect(getFn).toHaveBeenCalledWith("tpl-1");
    expect(renderFn).toHaveBeenCalledWith("Hello {{name}}, age {{months}} months", {
      name: "Mia",
      months: 3,
    });
    expect(executeFn).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO tenant_bootstrap_files"),
      ["tenant-001", "Hello Mia, age 3 months"],
    );
  });

  test("renderTenant throws when template not found", async () => {
    const { pool } = createMockPool();
    const store = createMockStore({ get: vi.fn().mockResolvedValue(null) });
    const engine = createMockEngine();

    const service = new RenderService(pool, store, engine);

    await expect(service.renderTenant("t-1", "missing", {})).rejects.toThrow(
      "Template not found: missing",
    );
  });

  test("reRenderByTemplate renders all associated tenants", async () => {
    const { pool } = createMockPool();
    const findTenantsFn = vi.fn().mockResolvedValue([
      { tenant_id: "t-1", template_data: { name: "A" } },
      { tenant_id: "t-2", template_data: { name: "B" } },
      { tenant_id: "t-3", template_data: { name: "C" } },
    ]);
    const store = createMockStore({
      get: vi.fn().mockResolvedValue({
        id: "tpl-1",
        name: "SOUL",
        template: "Hi {{name}}",
        schema_json: null,
        created_at: new Date(),
        updated_at: new Date(),
      }),
      findTenantsByTemplate: findTenantsFn,
    });
    const engine = createMockEngine();

    const service = new RenderService(pool, store, engine);
    const result = await service.reRenderByTemplate("tpl-1");

    expect(result.count).toBe(3);
    expect(result.errors).toHaveLength(0);
    expect(findTenantsFn).toHaveBeenCalledWith("tpl-1");
  });

  test("reRenderByTemplate collects errors without stopping", async () => {
    const { pool, executeFn } = createMockPool();
    // First call succeeds, second fails, third succeeds
    executeFn
      .mockResolvedValueOnce([[], []])
      .mockRejectedValueOnce(new Error("DB write failed"))
      .mockResolvedValueOnce([[], []]);

    const store = createMockStore({
      get: vi.fn().mockResolvedValue({
        id: "tpl-1",
        name: "SOUL",
        template: "Hi {{name}}",
        schema_json: null,
        created_at: new Date(),
        updated_at: new Date(),
      }),
      findTenantsByTemplate: vi.fn().mockResolvedValue([
        { tenant_id: "t-1", template_data: { name: "A" } },
        { tenant_id: "t-2", template_data: { name: "B" } },
        { tenant_id: "t-3", template_data: { name: "C" } },
      ]),
    });
    const engine = createMockEngine();

    const service = new RenderService(pool, store, engine);
    const result = await service.reRenderByTemplate("tpl-1");

    expect(result.count).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].tenantId).toBe("t-2");
    expect(result.errors[0].error).toBe("DB write failed");
  });
});
