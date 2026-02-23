import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createStateProviderFromConfig } from "./state-provider-factory.js";

// Mock the state module to avoid real DB connections and filesystem access.
vi.mock("../state/index.js", () => {
  const fileProvider = { id: "file" };
  const dbProvider = { id: "database" };
  return {
    createFileStateProvider: vi.fn(() => fileProvider),
    createDatabaseStateProvider: vi.fn(() => dbProvider),
    createDbPool: vi.fn((cfg: unknown) => cfg), // pass-through
  };
});

describe("createStateProviderFromConfig", () => {
  it("returns FileStateProvider when stateBackend is absent", () => {
    const cfg: OpenClawConfig = {};
    const provider = createStateProviderFromConfig(cfg);
    expect(provider.id).toBe("file");
  });

  it('returns FileStateProvider when stateBackend is "file"', () => {
    const cfg: OpenClawConfig = { gateway: { stateBackend: "file" } };
    const provider = createStateProviderFromConfig(cfg);
    expect(provider.id).toBe("file");
  });

  it('returns DatabaseStateProvider when stateBackend is "database" with valid config', () => {
    const cfg: OpenClawConfig = {
      gateway: {
        stateBackend: "database",
        database: {
          host: "localhost",
          user: "root",
          password: "secret",
          database: "openclaw",
        },
      },
    };
    const provider = createStateProviderFromConfig(cfg);
    expect(provider.id).toBe("database");
  });

  it('throws when stateBackend is "database" but database config is missing', () => {
    const cfg: OpenClawConfig = { gateway: { stateBackend: "database" } };
    expect(() => createStateProviderFromConfig(cfg)).toThrow(
      "gateway.stateBackend is 'database' but gateway.database config is missing",
    );
  });
});
