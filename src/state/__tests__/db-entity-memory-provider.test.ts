import type { Pool } from "mysql2/promise";
import { describe, expect, test, vi } from "vitest";
import {
  DatabaseEntityMemoryProvider,
  assembleMemoryMarkdown,
  mergeMedicalFacts,
} from "../db-entity-memory-provider.js";
import type { MemoryConcern, MemoryEpisode, MemoryProfile } from "../types.js";

// ── Mock factory ──────────────────────────────────────────────────────

function createMockPool() {
  const executeFn = vi.fn().mockResolvedValue([[], []]);
  const conn = {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue([[], []]),
    query: vi.fn().mockResolvedValue([[], []]),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
  const getConnectionFn = vi.fn().mockResolvedValue(conn);
  const pool = {
    execute: executeFn,
    getConnection: getConnectionFn,
  } as unknown as Pool;
  return { pool, executeFn, conn, getConnectionFn };
}

// ── Helpers for mock data ─────────────────────────────────────────────

function makeProfileRow(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: "t1",
    profile_data: JSON.stringify({ baby_snapshot: { name: "宝宝" } }),
    version: 1,
    last_interaction_at: "2026-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeEpisodeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    tenant_id: "t1",
    episode_type: "checkin",
    channel: "im",
    content: "宝宝今天状态不错",
    metadata: null,
    is_superseded: 0,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ── Test Group 1: ingest() normal path ────────────────────────────────

describe("DatabaseEntityMemoryProvider — ingest() normal path", () => {
  test("ingest with all options calls commit", async () => {
    const { pool, conn } = createMockPool();
    const provider = new DatabaseEntityMemoryProvider(pool);

    // SELECT FOR UPDATE returns empty (new profile)
    // All other conn.execute calls return default empty
    conn.execute.mockResolvedValue([[], []]);

    await provider.ingest("t1", {
      profileUpdates: { baby_snapshot: { name: "宝宝" } },
      episode: { episodeType: "checkin", channel: "im", content: "hi" },
      concerns: [
        {
          concernKey: "jaundice",
          displayName: "黄疸",
          severity: "high",
          evidenceText: "值偏高",
          source: "checkin",
        },
      ],
      render: true,
    });

    expect(conn.beginTransaction).toHaveBeenCalledOnce();
    expect(conn.commit).toHaveBeenCalledOnce();
    expect(conn.release).toHaveBeenCalled();
    // Multiple execute calls: profile SELECT FOR UPDATE + INSERT, episode INSERT,
    // concern INSERT + SELECT, render reads (profile, concerns, episodes) + MEMORY.md write
    expect(conn.execute.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  test("ingest with empty opts returns empty results", async () => {
    const { pool, conn } = createMockPool();
    const provider = new DatabaseEntityMemoryProvider(pool);

    // render=true by default, so render reads will happen
    const result = await provider.ingest("t1", {});

    expect(conn.beginTransaction).toHaveBeenCalledOnce();
    expect(conn.commit).toHaveBeenCalledOnce();
    // No profile, no episode, no concerns — render reads return empty → rendered: false
    expect(result.render).toEqual({ rendered: false });
  });

  test("ingest with profile creates new profile (version=0)", async () => {
    const { pool, conn } = createMockPool();
    const provider = new DatabaseEntityMemoryProvider(pool);

    // SELECT FOR UPDATE returns empty → new profile
    conn.execute.mockResolvedValue([[], []]);

    const result = await provider.ingest("t1", {
      profileUpdates: { baby_snapshot: { name: "宝宝" } },
      render: false,
    });

    expect(result.profile).toEqual({ updated: true, newVersion: 1 });

    // First call: SELECT FOR UPDATE, second call: INSERT
    const calls = conn.execute.mock.calls;
    expect(calls[0][0]).toContain("FOR UPDATE");
    expect(calls[1][0]).toContain("INSERT INTO oc_memory_profiles");
  });

  test("ingest with profile updates existing profile", async () => {
    const { pool, conn } = createMockPool();
    const provider = new DatabaseEntityMemoryProvider(pool);

    const existingRow = makeProfileRow({ version: 3 });
    // First call (SELECT FOR UPDATE) returns existing row
    conn.execute.mockResolvedValueOnce([[existingRow], []]);
    // Subsequent calls default to empty
    conn.execute.mockResolvedValue([[], []]);

    const result = await provider.ingest("t1", {
      profileUpdates: { baby_snapshot: { name: "updated" } },
      render: false,
    });

    expect(result.profile).toEqual({ updated: true, newVersion: 4 });

    // Second call should be UPDATE with version check
    const updateCall = conn.execute.mock.calls[1];
    expect(updateCall[0]).toContain("UPDATE oc_memory_profiles");
    expect(updateCall[1]).toContain(3); // version = 3
  });

  test("ingest merges medical_facts with dedup", async () => {
    const { pool, conn } = createMockPool();
    const provider = new DatabaseEntityMemoryProvider(pool);

    const existingRow = makeProfileRow({
      version: 1,
      profile_data: JSON.stringify({
        medical_facts: [{ fact: "A" }],
      }),
    });

    // SELECT FOR UPDATE returns existing row with fact A
    conn.execute.mockResolvedValueOnce([[existingRow], []]);
    conn.execute.mockResolvedValue([[], []]);

    await provider.ingest("t1", {
      profileUpdates: {
        medical_facts: [{ fact: "A" }, { fact: "B" }],
      },
      render: false,
    });

    // The UPDATE call (second execute) should have merged facts: A + B (deduped)
    const updateCall = conn.execute.mock.calls[1];
    const updatesJson = JSON.parse(updateCall[1][0] as string);
    expect(updatesJson.medical_facts).toHaveLength(2);
    expect(updatesJson.medical_facts).toEqual([{ fact: "A" }, { fact: "B" }]);
  });
});

// ── Test Group 2: ingest() rollback path ──────────────────────────────

describe("DatabaseEntityMemoryProvider — ingest() rollback path", () => {
  test("ingest rolls back on profile update failure", async () => {
    const { pool, conn } = createMockPool();
    const provider = new DatabaseEntityMemoryProvider(pool);

    // SELECT FOR UPDATE succeeds
    conn.execute.mockResolvedValueOnce([[], []]);
    // INSERT fails
    conn.execute.mockRejectedValueOnce(new Error("insert failed"));

    await expect(
      provider.ingest("t1", {
        profileUpdates: { baby_snapshot: {} },
        render: false,
      }),
    ).rejects.toThrow("insert failed");

    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });

  test("ingest rolls back on episode insert failure", async () => {
    const { pool, conn } = createMockPool();
    const provider = new DatabaseEntityMemoryProvider(pool);

    // Episode INSERT fails (first execute call since no profileUpdates)
    conn.execute.mockRejectedValueOnce(new Error("episode error"));

    await expect(
      provider.ingest("t1", {
        episode: { episodeType: "checkin", channel: "im", content: "hi" },
        render: false,
      }),
    ).rejects.toThrow("episode error");

    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });

  test("ingest rolls back on concern upsert failure", async () => {
    const { pool, conn } = createMockPool();
    const provider = new DatabaseEntityMemoryProvider(pool);

    // First execute: episode INSERT succeeds with insertId
    conn.execute.mockResolvedValueOnce([{ insertId: 1 }, []]);
    // Second execute: concern INSERT fails
    conn.execute.mockRejectedValueOnce(new Error("concern error"));

    await expect(
      provider.ingest("t1", {
        episode: { episodeType: "checkin", channel: "im", content: "hi" },
        concerns: [
          {
            concernKey: "k",
            displayName: "d",
            severity: "low",
            evidenceText: "t",
            source: "s",
          },
        ],
        render: false,
      }),
    ).rejects.toThrow("concern error");

    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });

  test("ingest rolls back on render failure", async () => {
    const { pool, conn } = createMockPool();
    const provider = new DatabaseEntityMemoryProvider(pool);

    // render=true (default), render reads will be the first execute calls
    // since no profileUpdates/episode/concerns
    // First execute (render profile read) fails
    conn.execute.mockRejectedValueOnce(new Error("render error"));

    await expect(provider.ingest("t1", {})).rejects.toThrow("render error");

    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });

  test("ingest always releases connection even on rollback failure", async () => {
    const { pool, conn } = createMockPool();
    const provider = new DatabaseEntityMemoryProvider(pool);

    // Execute fails
    conn.execute.mockRejectedValueOnce(new Error("exec error"));
    // Rollback also fails
    conn.rollback.mockRejectedValueOnce(new Error("rollback error"));

    await expect(
      provider.ingest("t1", {
        episode: { episodeType: "checkin", channel: "im", content: "hi" },
        render: false,
      }),
    ).rejects.toThrow("rollback error");

    expect(conn.release).toHaveBeenCalled();
  });
});

// ── Test Group 3: Deadlock handling ───────────────────────────────────

describe("DatabaseEntityMemoryProvider — deadlock handling", () => {
  test("ingest retries once on deadlock (ER_LOCK_DEADLOCK)", async () => {
    const { pool, getConnectionFn } = createMockPool();
    const provider = new DatabaseEntityMemoryProvider(pool);

    // First connection: deadlocks on first execute
    const conn1 = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      execute: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("Deadlock found"), { errno: 1213, code: "ER_LOCK_DEADLOCK" }),
        ),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };

    // Second connection: succeeds
    const conn2 = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue([[], []]),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };

    getConnectionFn.mockResolvedValueOnce(conn1).mockResolvedValueOnce(conn2);

    await provider.ingest("t1", {
      episode: { episodeType: "checkin", channel: "im", content: "hi" },
      render: false,
    });

    expect(getConnectionFn).toHaveBeenCalledTimes(2);
    expect(conn1.rollback).toHaveBeenCalled();
    expect(conn1.release).toHaveBeenCalled();
    expect(conn2.commit).toHaveBeenCalled();
    expect(conn2.release).toHaveBeenCalled();
  });

  test("ingest throws after max deadlock retries", async () => {
    const { pool, getConnectionFn } = createMockPool();
    const provider = new DatabaseEntityMemoryProvider(pool);

    const makeDeadlockConn = () => ({
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      execute: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("Deadlock found"), { errno: 1213, code: "ER_LOCK_DEADLOCK" }),
        ),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    });

    const conn1 = makeDeadlockConn();
    const conn2 = makeDeadlockConn();

    getConnectionFn.mockResolvedValueOnce(conn1).mockResolvedValueOnce(conn2);

    await expect(
      provider.ingest("t1", {
        episode: { episodeType: "checkin", channel: "im", content: "hi" },
        render: false,
      }),
    ).rejects.toThrow("Deadlock found");

    expect(getConnectionFn).toHaveBeenCalledTimes(2);
    expect(conn1.rollback).toHaveBeenCalled();
    expect(conn2.rollback).toHaveBeenCalled();
  });

  test("ingest does not retry on non-deadlock error", async () => {
    const { pool, conn, getConnectionFn } = createMockPool();
    const provider = new DatabaseEntityMemoryProvider(pool);

    conn.execute.mockRejectedValueOnce(
      Object.assign(new Error("Duplicate entry"), { errno: 1062, code: "ER_DUP_ENTRY" }),
    );

    await expect(
      provider.ingest("t1", {
        episode: { episodeType: "checkin", channel: "im", content: "hi" },
        render: false,
      }),
    ).rejects.toThrow("Duplicate entry");

    expect(getConnectionFn).toHaveBeenCalledTimes(1);
    expect(conn.rollback).toHaveBeenCalled();
  });
});

// ── Test Group 4: Independent CRUD methods ────────────────────────────

describe("DatabaseEntityMemoryProvider — CRUD methods", () => {
  test("getProfile returns null for nonexistent tenant", async () => {
    const { pool } = createMockPool();
    const provider = new DatabaseEntityMemoryProvider(pool);

    const result = await provider.getProfile("nonexistent");
    expect(result).toBeNull();
  });

  test("getProfile returns parsed profile", async () => {
    const { pool, executeFn } = createMockPool();
    const provider = new DatabaseEntityMemoryProvider(pool);

    const row = makeProfileRow();
    executeFn.mockResolvedValueOnce([[row], []]);

    const result = await provider.getProfile("t1");

    expect(result).not.toBeNull();
    expect(result!.tenantId).toBe("t1");
    expect(result!.profileData).toEqual({ baby_snapshot: { name: "宝宝" } });
    expect(result!.version).toBe(1);
  });

  test("upsertProfile creates new when version=0", async () => {
    const { pool, executeFn } = createMockPool();
    const provider = new DatabaseEntityMemoryProvider(pool);

    executeFn.mockResolvedValueOnce([{ affectedRows: 1 }, []]);

    const result = await provider.upsertProfile("t1", { baby_snapshot: {} }, 0);

    expect(result).toEqual({ updated: true, newVersion: 1 });
    const sql = executeFn.mock.calls[0][0] as string;
    expect(sql).toContain("INSERT INTO oc_memory_profiles");
    expect(sql).toContain("ON DUPLICATE KEY UPDATE");
  });

  test("upsertProfile updates existing with version check", async () => {
    const { pool, executeFn } = createMockPool();
    const provider = new DatabaseEntityMemoryProvider(pool);

    executeFn.mockResolvedValueOnce([{ affectedRows: 1 }, []]);

    const result = await provider.upsertProfile("t1", { baby_snapshot: {} }, 5);

    expect(result).toEqual({ updated: true, newVersion: 6 });
    const sql = executeFn.mock.calls[0][0] as string;
    expect(sql).toContain("UPDATE oc_memory_profiles");
    expect(sql).toContain("WHERE tenant_id = ? AND version = ?");
    expect(executeFn.mock.calls[0][1]).toContain(5);
  });

  test("insertEpisode returns insertId", async () => {
    const { pool, executeFn } = createMockPool();
    const provider = new DatabaseEntityMemoryProvider(pool);

    executeFn.mockResolvedValueOnce([{ insertId: 42 }, []]);

    const result = await provider.insertEpisode("t1", {
      episodeType: "checkin",
      channel: "im",
      content: "test content",
    });

    expect(result).toEqual({ id: 42 });
  });

  test("getRecentEpisodes with limit and type", async () => {
    const { pool, executeFn } = createMockPool();
    const provider = new DatabaseEntityMemoryProvider(pool);

    const row = makeEpisodeRow();
    executeFn.mockResolvedValueOnce([[row], []]);

    const result = await provider.getRecentEpisodes("t1", { limit: 5, episodeType: "checkin" });

    expect(result).toHaveLength(1);
    expect(result[0].episodeType).toBe("checkin");
    // Verify SQL passes episodeType filter
    const sql = executeFn.mock.calls[0][0] as string;
    expect(sql).toContain("episode_type = ?");
    expect(executeFn.mock.calls[0][1]).toContain("checkin");
  });

  test("upsertConcern SQL contains severity escalation logic", async () => {
    const { pool, executeFn } = createMockPool();
    const provider = new DatabaseEntityMemoryProvider(pool);

    // First call: INSERT/UPSERT, second call: SELECT to read back
    executeFn.mockResolvedValueOnce([{}, []]);
    executeFn.mockResolvedValueOnce([[{ id: 7, mention_count: 3 }], []]);

    const result = await provider.upsertConcern("t1", {
      concernKey: "jaundice",
      displayName: "黄疸",
      severity: "high",
      evidenceText: "值偏高",
      source: "checkin",
    });

    expect(result).toEqual({ id: 7, mentionCount: 3 });
    const sql = executeFn.mock.calls[0][0] as string;
    expect(sql).toContain("FIELD(VALUES(severity)");
    expect(sql).toContain("FIELD(severity,");
  });

  test("updateConcernStatus clears resolved_at for improving", async () => {
    const { pool, executeFn } = createMockPool();
    const provider = new DatabaseEntityMemoryProvider(pool);

    executeFn.mockResolvedValueOnce([{ affectedRows: 1 }, []]);

    const result = await provider.updateConcernStatus("t1", "jaundice", "improving");

    expect(result).toEqual({ updated: 1 });
    const sql = executeFn.mock.calls[0][0] as string;
    expect(sql).toContain("resolved_at = NULL");
  });

  test("updateConcernStatus sets resolved_at for resolved", async () => {
    const { pool, executeFn } = createMockPool();
    const provider = new DatabaseEntityMemoryProvider(pool);

    executeFn.mockResolvedValueOnce([{ affectedRows: 1 }, []]);

    const result = await provider.updateConcernStatus("t1", "jaundice", "resolved");

    expect(result).toEqual({ updated: 1 });
    const sql = executeFn.mock.calls[0][0] as string;
    expect(sql).toContain("resolved_at = CURRENT_TIMESTAMP");
  });

  test("renderMemoryFile returns rendered=false when no data", async () => {
    const { pool, executeFn } = createMockPool();
    const provider = new DatabaseEntityMemoryProvider(pool);

    // getProfile → empty, getActiveConcerns → empty, getRecentEpisodes → empty
    executeFn.mockResolvedValue([[], []]);

    const result = await provider.renderMemoryFile("t1");
    expect(result).toEqual({ rendered: false });
  });
});

// ── Test Group 5: Helper functions ────────────────────────────────────

describe("mergeMedicalFacts", () => {
  test("deduplicates by fact field", () => {
    const existing = [{ fact: "A" }, { fact: "B" }];
    const incoming = [{ fact: "B" }, { fact: "C" }];
    const result = mergeMedicalFacts(existing, incoming);
    expect(result).toHaveLength(3);
    expect(result.map((f) => f.fact)).toEqual(["A", "B", "C"]);
  });

  test("handles empty existing array", () => {
    const result = mergeMedicalFacts([], [{ fact: "A" }]);
    expect(result).toHaveLength(1);
  });

  test("handles empty incoming array", () => {
    const result = mergeMedicalFacts([{ fact: "A" }], []);
    expect(result).toHaveLength(1);
  });
});

describe("assembleMemoryMarkdown", () => {
  const baseProfile: MemoryProfile = {
    tenantId: "t1",
    profileData: {
      medical_facts: [{ fact: "早产28周" }],
      baby_snapshot: { name: "宝宝", weight: "2.1kg" },
      feeding_profile: { method: "母乳" },
      next_actions: [{ fact: "复查黄疸" }],
    },
    version: 1,
    lastInteractionAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  const baseConcerns: MemoryConcern[] = [
    {
      id: 1,
      tenantId: "t1",
      concernKey: "jaundice",
      displayName: "黄疸偏高",
      severity: "high",
      status: "active",
      mentionCount: 2,
      evidence: [{ text: "值15", source: "checkin", date: "2026-01-01" }],
      firstSeenAt: "2026-01-01T00:00:00Z",
      lastSeenAt: "2026-01-01T00:00:00Z",
      resolvedAt: null,
      followupDue: null,
    },
    {
      id: 2,
      tenantId: "t1",
      concernKey: "weight",
      displayName: "体重增长慢",
      severity: "low",
      status: "active",
      mentionCount: 1,
      evidence: [{ text: "增长缓慢", source: "checkin", date: "2026-01-01" }],
      firstSeenAt: "2026-01-01T00:00:00Z",
      lastSeenAt: "2026-01-01T00:00:00Z",
      resolvedAt: null,
      followupDue: null,
    },
  ];

  const baseEpisodes: MemoryEpisode[] = [
    {
      id: 1,
      tenantId: "t1",
      episodeType: "checkin",
      channel: "im",
      content: "宝宝今天状态不错",
      metadata: null,
      isSuperseded: false,
      createdAt: "2026-01-01T00:00:00Z",
    },
  ];

  test("returns null when no data", () => {
    expect(assembleMemoryMarkdown(null, [], [])).toBeNull();
  });

  test("includes all sections", () => {
    const md = assembleMemoryMarkdown(baseProfile, baseConcerns, baseEpisodes);
    expect(md).not.toBeNull();
    expect(md).toContain("# 记忆档案");
    expect(md).toContain("## 重要医疗信息");
    expect(md).toContain("## 宝宝基本信息");
    expect(md).toContain("## 喂养情况");
    expect(md).toContain("## 待办事项");
    expect(md).toContain("## 当前关注事项");
    expect(md).toContain("## 近期记录");
  });

  test("marks high/critical concerns with [!]", () => {
    const md = assembleMemoryMarkdown(null, baseConcerns, [])!;
    // "黄疸偏高" is severity=high → should have [!]
    expect(md).toContain("[!] 黄疸偏高");
    // "体重增长慢" is severity=low → should NOT have [!]
    expect(md).not.toContain("[!] 体重增长慢");
    expect(md).toContain("- 体重增长慢");
  });

  test("marks critical concerns with [!]", () => {
    const criticalConcern: MemoryConcern = {
      ...baseConcerns[0],
      severity: "critical",
      displayName: "呼吸异常",
    };
    const md = assembleMemoryMarkdown(null, [criticalConcern], [])!;
    expect(md).toContain("[!] 呼吸异常");
  });

  test("truncates episode content over 100 chars", () => {
    const longContent = "A".repeat(150);
    const episode: MemoryEpisode = {
      ...baseEpisodes[0],
      content: longContent,
    };
    const md = assembleMemoryMarkdown(null, [], [episode])!;
    // Should contain first 100 chars + "..."
    expect(md).toContain("A".repeat(100) + "...");
    expect(md).not.toContain("A".repeat(101));
  });

  test("does not truncate episode content under 100 chars", () => {
    const shortContent = "A".repeat(50);
    const episode: MemoryEpisode = {
      ...baseEpisodes[0],
      content: shortContent,
    };
    const md = assembleMemoryMarkdown(null, [], [episode])!;
    expect(md).toContain("A".repeat(50));
    expect(md).not.toContain("...");
  });
});
