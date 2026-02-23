import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store.js";
import { FileSessionStoreProvider } from "../file-session-store-provider.js";

describe("FileSessionStoreProvider", () => {
  let fixtureRoot = "";
  let fixtureCount = 0;
  const provider = new FileSessionStoreProvider();

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-file-session-provider-"));
  });

  afterAll(async () => {
    clearSessionStoreCacheForTest();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  function storePath(label: string): string {
    return path.join(fixtureRoot, `${label}-${fixtureCount++}`, "sessions.json");
  }

  it("loadSessionStore returns {} for non-existent file", () => {
    const result = provider.loadSessionStore(storePath("empty"));
    expect(result).toEqual({});
  });

  it("save then load round-trips correctly", async () => {
    const sp = storePath("roundtrip");
    await fs.mkdir(path.dirname(sp), { recursive: true });

    const entry = {
      sessionId: "s1",
      updatedAt: Date.now(),
    };
    await provider.saveSessionStore(sp, { alice: entry });

    clearSessionStoreCacheForTest();
    const loaded = provider.loadSessionStore(sp);
    expect(loaded.alice).toBeDefined();
    expect(loaded.alice.sessionId).toBe("s1");
  });

  it("updateSessionStore mutator executes correctly", async () => {
    const sp = storePath("update");
    await fs.mkdir(path.dirname(sp), { recursive: true });

    const now = Date.now();
    await provider.saveSessionStore(sp, {
      bob: { sessionId: "s2", updatedAt: now },
    });

    clearSessionStoreCacheForTest();
    const result = await provider.updateSessionStore(sp, (store) => {
      store.bob.sessionId = "s2-updated";
      return "mutated";
    });

    expect(result).toBe("mutated");

    clearSessionStoreCacheForTest();
    const loaded = provider.loadSessionStore(sp);
    expect(loaded.bob.sessionId).toBe("s2-updated");
  });

  it("loadSessionStore returns {} for empty JSON file", async () => {
    const sp = storePath("empty-json");
    await fs.mkdir(path.dirname(sp), { recursive: true });
    await fs.writeFile(sp, "", "utf-8");

    clearSessionStoreCacheForTest();
    const result = provider.loadSessionStore(sp);
    expect(result).toEqual({});
  });
});
