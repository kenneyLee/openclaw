/**
 * Database Entity Memory Provider
 *
 * Implements EntityMemoryProvider using MySQL (mysql2/promise).
 * Three tables: oc_memory_profiles, oc_memory_episodes, oc_memory_concerns.
 * Also renders MEMORY.md into tenant_bootstrap_files.
 */

import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { EntityMemoryProvider, MemoryConcern, MemoryEpisode, MemoryProfile } from "./types.js";

// ── Row interfaces ──────────────────────────────────────────────────

interface ProfileRow extends RowDataPacket {
  tenant_id: string;
  profile_data: Record<string, unknown> | string;
  version: number;
  last_interaction_at: string | null;
  created_at: string;
  updated_at: string;
}

interface EpisodeRow extends RowDataPacket {
  id: number;
  tenant_id: string;
  episode_type: string;
  channel: string;
  content: string;
  metadata: Record<string, unknown> | string | null;
  is_superseded: number;
  created_at: string;
}

interface ConcernRow extends RowDataPacket {
  id: number;
  tenant_id: string;
  concern_key: string;
  display_name: string;
  severity: "low" | "medium" | "high" | "critical";
  status: "active" | "improving" | "resolved" | "escalated";
  mention_count: number;
  evidence: Array<{ text: string; source: string; date: string }> | string;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  followup_due: string | null;
  created_at: string;
  updated_at: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

function parseJson<T>(val: T | string): T {
  if (typeof val === "string") {
    return JSON.parse(val) as T;
  }
  return val;
}

function fmtDate(ts: string): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function formatFact(f: unknown): string {
  if (typeof f === "string") {
    return f;
  }
  if (f && typeof f === "object") {
    const obj = f as Record<string, unknown>;
    return (obj.fact as string) ?? (obj.text as string) ?? JSON.stringify(f);
  }
  return JSON.stringify(f);
}

function rowToProfile(row: ProfileRow): MemoryProfile {
  return {
    tenantId: row.tenant_id,
    profileData: parseJson<Record<string, unknown>>(row.profile_data),
    version: row.version,
    lastInteractionAt: row.last_interaction_at ? String(row.last_interaction_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToEpisode(row: EpisodeRow): MemoryEpisode {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    episodeType: row.episode_type,
    channel: row.channel,
    content: row.content,
    metadata: row.metadata ? parseJson<Record<string, unknown>>(row.metadata) : null,
    isSuperseded: row.is_superseded === 1,
    createdAt: String(row.created_at),
  };
}

function rowToConcern(row: ConcernRow): MemoryConcern {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    concernKey: row.concern_key,
    displayName: row.display_name,
    severity: row.severity,
    status: row.status,
    mentionCount: row.mention_count,
    evidence: parseJson<Array<{ text: string; source: string; date: string }>>(row.evidence),
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
    resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
    followupDue: row.followup_due ? String(row.followup_due) : null,
  };
}

/**
 * Assemble MEMORY.md content from profile, concerns, and episodes.
 * Returns null if there is no data to render.
 * @internal Exported for unit testing.
 */
export function assembleMemoryMarkdown(
  profile: MemoryProfile | null,
  concerns: MemoryConcern[],
  episodes: MemoryEpisode[],
): string | null {
  if (!profile && concerns.length === 0 && episodes.length === 0) {
    return null;
  }

  const parts: string[] = ["# 记忆档案\n"];

  if (profile?.profileData) {
    const data = profile.profileData;

    if (Array.isArray(data.medical_facts) && data.medical_facts.length > 0) {
      parts.push("## 重要医疗信息");
      for (const f of data.medical_facts) {
        parts.push(`- ${formatFact(f)}`);
      }
      parts.push("");
    }

    if (data.baby_snapshot && typeof data.baby_snapshot === "object") {
      parts.push("## 宝宝基本信息");
      const snap = data.baby_snapshot as Record<string, unknown>;
      for (const [k, v] of Object.entries(snap)) {
        if (v !== null && v !== undefined && v !== "") {
          parts.push(
            `- ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v as string | number | boolean)}`,
          );
        }
      }
      parts.push("");
    }

    if (data.feeding_profile && typeof data.feeding_profile === "object") {
      parts.push("## 喂养情况");
      const fp = data.feeding_profile as Record<string, unknown>;
      for (const [k, v] of Object.entries(fp)) {
        if (v !== null && v !== undefined && v !== "") {
          parts.push(
            `- ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v as string | number | boolean)}`,
          );
        }
      }
      parts.push("");
    }

    if (Array.isArray(data.next_actions) && data.next_actions.length > 0) {
      parts.push("## 待办事项");
      for (const a of data.next_actions) {
        parts.push(`- ${formatFact(a)}`);
      }
      parts.push("");
    }
  }

  if (concerns.length > 0) {
    parts.push("## 当前关注事项");
    for (const c of concerns) {
      const marker = c.severity === "critical" || c.severity === "high" ? "[!] " : "";
      parts.push(
        `- ${marker}${c.displayName} (${c.severity}, 已提及${c.mentionCount}次, 最近: ${fmtDate(c.lastSeenAt)})`,
      );
    }
    parts.push("");
  }

  if (episodes.length > 0) {
    parts.push("## 近期记录");
    for (const e of episodes) {
      parts.push(`- [${fmtDate(e.createdAt)} ${e.channel}] ${truncate(e.content, 100)}`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * Merge new medical_facts into existing ones with deduplication.
 * @internal Exported for unit testing.
 */
export function mergeMedicalFacts(
  existing: Array<Record<string, unknown>>,
  incoming: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const merged = [...existing];
  for (const nf of incoming) {
    const factText = (nf.fact as string) ?? (nf.text as string) ?? "";
    if (!factText) {
      continue;
    }
    const exists = merged.some(
      (ef) => ((ef.fact as string) ?? (ef.text as string) ?? "") === factText,
    );
    if (!exists) {
      merged.push(nf);
    }
  }
  return merged;
}

// ── Provider ────────────────────────────────────────────────────────

export class DatabaseEntityMemoryProvider implements EntityMemoryProvider {
  constructor(private readonly pool: Pool) {}

  // ── Profile ─────────────────────────────────────────────────────

  async getProfile(tenantId: string): Promise<MemoryProfile | null> {
    const [rows] = await this.pool.execute<ProfileRow[]>(
      `SELECT tenant_id, profile_data, version, last_interaction_at, created_at, updated_at
       FROM oc_memory_profiles WHERE tenant_id = ?`,
      [tenantId],
    );
    if (rows.length === 0) {
      return null;
    }
    return rowToProfile(rows[0]);
  }

  async upsertProfile(
    tenantId: string,
    updates: Record<string, unknown>,
    expectedVersion: number,
  ): Promise<{ updated: boolean; newVersion: number }> {
    const updatesJson = JSON.stringify(updates);

    if (expectedVersion === 0) {
      // No existing profile — INSERT
      await this.pool.execute(
        `INSERT INTO oc_memory_profiles (tenant_id, profile_data, version, last_interaction_at)
         VALUES (?, ?, 1, CURRENT_TIMESTAMP)
         ON DUPLICATE KEY UPDATE
           profile_data = JSON_MERGE_PATCH(profile_data, VALUES(profile_data)),
           version = version + 1,
           last_interaction_at = CURRENT_TIMESTAMP`,
        [tenantId, updatesJson],
      );
      return { updated: true, newVersion: 1 };
    }

    // Optimistic lock: UPDATE WHERE version = expectedVersion
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE oc_memory_profiles
       SET profile_data = JSON_MERGE_PATCH(profile_data, ?),
           version = version + 1,
           last_interaction_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND version = ?`,
      [updatesJson, tenantId, expectedVersion],
    );

    if (result.affectedRows > 0) {
      return { updated: true, newVersion: expectedVersion + 1 };
    }

    // Version mismatch — re-read and retry once
    const current = await this.getProfile(tenantId);
    if (!current) {
      // Was deleted concurrently — insert fresh
      await this.pool.execute(
        `INSERT INTO oc_memory_profiles (tenant_id, profile_data, version, last_interaction_at)
         VALUES (?, ?, 1, CURRENT_TIMESTAMP)`,
        [tenantId, updatesJson],
      );
      return { updated: true, newVersion: 1 };
    }

    const [retry] = await this.pool.execute<ResultSetHeader>(
      `UPDATE oc_memory_profiles
       SET profile_data = JSON_MERGE_PATCH(profile_data, ?),
           version = version + 1,
           last_interaction_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND version = ?`,
      [updatesJson, tenantId, current.version],
    );
    return { updated: retry.affectedRows > 0, newVersion: current.version + 1 };
  }

  // ── Episodes ────────────────────────────────────────────────────

  async insertEpisode(
    tenantId: string,
    episode: {
      episodeType: string;
      channel: string;
      content: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ id: number }> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO oc_memory_episodes (tenant_id, episode_type, channel, content, metadata)
       VALUES (?, ?, ?, ?, ?)`,
      [
        tenantId,
        episode.episodeType,
        episode.channel,
        episode.content,
        episode.metadata ? JSON.stringify(episode.metadata) : null,
      ],
    );
    return { id: result.insertId };
  }

  async getRecentEpisodes(
    tenantId: string,
    opts?: { limit?: number; episodeType?: string },
  ): Promise<MemoryEpisode[]> {
    const limit = opts?.limit ?? 20;

    if (opts?.episodeType) {
      const [rows] = await this.pool.execute<EpisodeRow[]>(
        `SELECT id, tenant_id, episode_type, channel, content, metadata, is_superseded, created_at
         FROM oc_memory_episodes
         WHERE tenant_id = ? AND episode_type = ? AND is_superseded = 0
         ORDER BY created_at DESC LIMIT ?`,
        [tenantId, opts.episodeType, String(limit)],
      );
      return rows.map(rowToEpisode);
    }

    const [rows] = await this.pool.execute<EpisodeRow[]>(
      `SELECT id, tenant_id, episode_type, channel, content, metadata, is_superseded, created_at
       FROM oc_memory_episodes
       WHERE tenant_id = ? AND is_superseded = 0
       ORDER BY created_at DESC LIMIT ?`,
      [tenantId, String(limit)],
    );
    return rows.map(rowToEpisode);
  }

  async getEpisodesSince(
    tenantId: string,
    since: Date,
    opts?: { limit?: number },
  ): Promise<MemoryEpisode[]> {
    const limit = opts?.limit ?? 100;
    const sinceStr = since.toISOString().slice(0, 19).replace("T", " ");
    const [rows] = await this.pool.execute<EpisodeRow[]>(
      `SELECT id, tenant_id, episode_type, channel, content, metadata, is_superseded, created_at
       FROM oc_memory_episodes
       WHERE tenant_id = ? AND is_superseded = 0 AND created_at >= ?
       ORDER BY created_at DESC LIMIT ?`,
      [tenantId, sinceStr, String(limit)],
    );
    return rows.map(rowToEpisode);
  }

  // ── Concerns ────────────────────────────────────────────────────

  async upsertConcern(
    tenantId: string,
    concern: {
      concernKey: string;
      displayName: string;
      severity: "low" | "medium" | "high" | "critical";
      evidenceText: string;
      source: string;
    },
  ): Promise<{ id: number; mentionCount: number }> {
    const evidenceObj = JSON.stringify({
      text: concern.evidenceText,
      source: concern.source,
      date: new Date().toISOString().slice(0, 10),
    });

    const initialEvidence = JSON.stringify([
      {
        text: concern.evidenceText,
        source: concern.source,
        date: new Date().toISOString().slice(0, 10),
      },
    ]);

    await this.pool.execute(
      `INSERT INTO oc_memory_concerns
         (tenant_id, concern_key, display_name, severity, evidence)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         mention_count = mention_count + 1,
         evidence = JSON_ARRAY_APPEND(evidence, '$', CAST(? AS JSON)),
         severity = CASE
           WHEN FIELD(VALUES(severity), 'low','medium','high','critical')
              > FIELD(severity, 'low','medium','high','critical')
           THEN VALUES(severity) ELSE severity END,
         last_seen_at = CURRENT_TIMESTAMP,
         resolved_at = CASE WHEN status = 'resolved' THEN NULL ELSE resolved_at END,
         status = CASE WHEN status = 'resolved' THEN 'active' ELSE status END`,
      [
        tenantId,
        concern.concernKey,
        concern.displayName,
        concern.severity,
        initialEvidence,
        evidenceObj,
      ],
    );

    // Read back the row to get id + mentionCount
    const [rows] = await this.pool.execute<ConcernRow[]>(
      `SELECT id, mention_count FROM oc_memory_concerns
       WHERE tenant_id = ? AND concern_key = ?`,
      [tenantId, concern.concernKey],
    );
    if (rows.length === 0) {
      return { id: 0, mentionCount: 1 };
    }
    return { id: rows[0].id, mentionCount: rows[0].mention_count };
  }

  async getActiveConcerns(tenantId: string): Promise<MemoryConcern[]> {
    const [rows] = await this.pool.execute<ConcernRow[]>(
      `SELECT id, tenant_id, concern_key, display_name, severity, status,
              mention_count, evidence, first_seen_at, last_seen_at,
              resolved_at, followup_due, created_at, updated_at
       FROM oc_memory_concerns
       WHERE tenant_id = ? AND status IN ('active', 'improving', 'escalated')
       ORDER BY FIELD(severity, 'critical','high','medium','low'), last_seen_at DESC`,
      [tenantId],
    );
    return rows.map(rowToConcern);
  }

  async getAllConcerns(tenantId: string): Promise<MemoryConcern[]> {
    const [rows] = await this.pool.execute<ConcernRow[]>(
      `SELECT id, tenant_id, concern_key, display_name, severity, status,
              mention_count, evidence, first_seen_at, last_seen_at,
              resolved_at, followup_due, created_at, updated_at
       FROM oc_memory_concerns
       WHERE tenant_id = ?
       ORDER BY FIELD(status, 'active','improving','escalated','resolved'),
                FIELD(severity, 'critical','high','medium','low'),
                last_seen_at DESC`,
      [tenantId],
    );
    return rows.map(rowToConcern);
  }

  async updateConcernStatus(
    tenantId: string,
    concernKey: string,
    status: "improving" | "resolved" | "escalated",
  ): Promise<{ updated: number }> {
    const allowed = new Set(["improving", "resolved", "escalated"]);
    if (!allowed.has(status)) {
      return { updated: 0 };
    }

    if (status === "resolved") {
      const [result] = await this.pool.execute<ResultSetHeader>(
        `UPDATE oc_memory_concerns
         SET status = ?, resolved_at = CURRENT_TIMESTAMP
         WHERE tenant_id = ? AND concern_key = ?`,
        [status, tenantId, concernKey],
      );
      return { updated: result.affectedRows };
    }

    // For improving/escalated, clear resolved_at (may have been set previously)
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE oc_memory_concerns
       SET status = ?, resolved_at = NULL
       WHERE tenant_id = ? AND concern_key = ?`,
      [status, tenantId, concernKey],
    );
    return { updated: result.affectedRows };
  }

  // ── MEMORY.md rendering ─────────────────────────────────────────

  async renderMemoryFile(tenantId: string): Promise<{ rendered: boolean }> {
    const [profile, concerns, episodes] = await Promise.all([
      this.getProfile(tenantId),
      this.getActiveConcerns(tenantId),
      this.getRecentEpisodes(tenantId, { limit: 10 }),
    ]);

    const content = assembleMemoryMarkdown(profile, concerns, episodes);
    if (!content) {
      return { rendered: false };
    }

    await this.pool.execute(
      `INSERT INTO tenant_bootstrap_files (tenant_id, file_name, content)
       VALUES (?, 'MEMORY.md', ?)
       ON DUPLICATE KEY UPDATE content = VALUES(content), updated_at = CURRENT_TIMESTAMP`,
      [tenantId, content],
    );

    return { rendered: true };
  }

  // ── Transactional batch ingest ──────────────────────────────────
  //
  // Wraps profile update + episode insert + concern upserts + MEMORY.md
  // render in a single MySQL transaction. Uses SELECT … FOR UPDATE on
  // profile to prevent concurrent medical_facts data loss.

  async ingest(
    tenantId: string,
    opts: {
      profileUpdates?: Record<string, unknown>;
      episode?: {
        episodeType: string;
        channel: string;
        content: string;
        metadata?: Record<string, unknown>;
      };
      concerns?: Array<{
        concernKey: string;
        displayName: string;
        severity: "low" | "medium" | "high" | "critical";
        evidenceText: string;
        source: string;
      }>;
      render?: boolean;
    },
    retryCount = 0,
  ): Promise<{
    profile?: { updated: boolean; newVersion: number };
    episode?: { id: number };
    concerns?: Array<{ id: number; mentionCount: number }>;
    render?: { rendered: boolean };
  }> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      const results: Record<string, unknown> = {};

      // ── 1. Profile update (with FOR UPDATE lock + medical_facts merge) ──

      if (opts.profileUpdates && Object.keys(opts.profileUpdates).length > 0) {
        const [profileRows] = await conn.execute<ProfileRow[]>(
          `SELECT tenant_id, profile_data, version, last_interaction_at, created_at, updated_at
           FROM oc_memory_profiles WHERE tenant_id = ? FOR UPDATE`,
          [tenantId],
        );
        const current = profileRows.length > 0 ? rowToProfile(profileRows[0]) : null;
        const currentVersion = current?.version ?? 0;

        let updates = { ...opts.profileUpdates };

        // medical_facts: append + deduplicate against locked current snapshot
        if (Array.isArray(updates.medical_facts) && updates.medical_facts.length > 0) {
          const existingFacts = Array.isArray(current?.profileData?.medical_facts)
            ? (current.profileData.medical_facts as Array<Record<string, unknown>>)
            : [];
          updates = {
            ...updates,
            medical_facts: mergeMedicalFacts(
              existingFacts,
              updates.medical_facts as Array<Record<string, unknown>>,
            ),
          };
        }

        const updatesJson = JSON.stringify(updates);

        if (currentVersion === 0) {
          await conn.execute(
            `INSERT INTO oc_memory_profiles (tenant_id, profile_data, version, last_interaction_at)
             VALUES (?, ?, 1, CURRENT_TIMESTAMP)
             ON DUPLICATE KEY UPDATE
               profile_data = JSON_MERGE_PATCH(profile_data, VALUES(profile_data)),
               version = version + 1,
               last_interaction_at = CURRENT_TIMESTAMP`,
            [tenantId, updatesJson],
          );
          results.profile = { updated: true, newVersion: 1 };
        } else {
          await conn.execute<ResultSetHeader>(
            `UPDATE oc_memory_profiles
             SET profile_data = JSON_MERGE_PATCH(profile_data, ?),
                 version = version + 1,
                 last_interaction_at = CURRENT_TIMESTAMP
             WHERE tenant_id = ? AND version = ?`,
            [updatesJson, tenantId, currentVersion],
          );
          results.profile = { updated: true, newVersion: currentVersion + 1 };
        }
      }

      // ── 2. Episode insert ──

      if (opts.episode) {
        const [result] = await conn.execute<ResultSetHeader>(
          `INSERT INTO oc_memory_episodes (tenant_id, episode_type, channel, content, metadata)
           VALUES (?, ?, ?, ?, ?)`,
          [
            tenantId,
            opts.episode.episodeType,
            opts.episode.channel,
            opts.episode.content,
            opts.episode.metadata ? JSON.stringify(opts.episode.metadata) : null,
          ],
        );
        results.episode = { id: result.insertId };
      }

      // ── 3. Concern upserts (clears resolved_at on reactivation) ──

      if (opts.concerns && opts.concerns.length > 0) {
        const concernResults: Array<{ id: number; mentionCount: number }> = [];
        for (const c of opts.concerns) {
          const evidenceObj = JSON.stringify({
            text: c.evidenceText,
            source: c.source,
            date: new Date().toISOString().slice(0, 10),
          });
          const initialEvidence = JSON.stringify([
            {
              text: c.evidenceText,
              source: c.source,
              date: new Date().toISOString().slice(0, 10),
            },
          ]);

          await conn.execute(
            `INSERT INTO oc_memory_concerns
               (tenant_id, concern_key, display_name, severity, evidence)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               mention_count = mention_count + 1,
               evidence = JSON_ARRAY_APPEND(evidence, '$', CAST(? AS JSON)),
               severity = CASE
                 WHEN FIELD(VALUES(severity), 'low','medium','high','critical')
                    > FIELD(severity, 'low','medium','high','critical')
                 THEN VALUES(severity) ELSE severity END,
               last_seen_at = CURRENT_TIMESTAMP,
               resolved_at = CASE WHEN status = 'resolved' THEN NULL ELSE resolved_at END,
               status = CASE WHEN status = 'resolved' THEN 'active' ELSE status END`,
            [tenantId, c.concernKey, c.displayName, c.severity, initialEvidence, evidenceObj],
          );

          const [rows] = await conn.execute<ConcernRow[]>(
            `SELECT id, mention_count FROM oc_memory_concerns
             WHERE tenant_id = ? AND concern_key = ?`,
            [tenantId, c.concernKey],
          );
          if (rows.length > 0) {
            concernResults.push({ id: rows[0].id, mentionCount: rows[0].mention_count });
          } else {
            concernResults.push({ id: 0, mentionCount: 1 });
          }
        }
        results.concerns = concernResults;
      }

      // ── 4. Render MEMORY.md (within transaction to see uncommitted data) ──

      if (opts.render !== false) {
        // Read data using the transaction connection
        const [pRows] = await conn.execute<ProfileRow[]>(
          `SELECT tenant_id, profile_data, version, last_interaction_at, created_at, updated_at
           FROM oc_memory_profiles WHERE tenant_id = ?`,
          [tenantId],
        );
        const renderProfile = pRows.length > 0 ? rowToProfile(pRows[0]) : null;

        const [cRows] = await conn.execute<ConcernRow[]>(
          `SELECT id, tenant_id, concern_key, display_name, severity, status,
                  mention_count, evidence, first_seen_at, last_seen_at,
                  resolved_at, followup_due, created_at, updated_at
           FROM oc_memory_concerns
           WHERE tenant_id = ? AND status IN ('active', 'improving', 'escalated')
           ORDER BY FIELD(severity, 'critical','high','medium','low'), last_seen_at DESC`,
          [tenantId],
        );
        const renderConcerns = cRows.map(rowToConcern);

        const [eRows] = await conn.execute<EpisodeRow[]>(
          `SELECT id, tenant_id, episode_type, channel, content, metadata, is_superseded, created_at
           FROM oc_memory_episodes
           WHERE tenant_id = ? AND is_superseded = 0
           ORDER BY created_at DESC LIMIT ?`,
          [tenantId, String(10)],
        );
        const renderEpisodes = eRows.map(rowToEpisode);

        const markdownContent = assembleMemoryMarkdown(
          renderProfile,
          renderConcerns,
          renderEpisodes,
        );
        if (markdownContent) {
          await conn.execute(
            `INSERT INTO tenant_bootstrap_files (tenant_id, file_name, content)
             VALUES (?, 'MEMORY.md', ?)
             ON DUPLICATE KEY UPDATE content = VALUES(content), updated_at = CURRENT_TIMESTAMP`,
            [tenantId, markdownContent],
          );
          results.render = { rendered: true };
        } else {
          results.render = { rendered: false };
        }
      }

      await conn.commit();

      return results as {
        profile?: { updated: boolean; newVersion: number };
        episode?: { id: number };
        concerns?: Array<{ id: number; mentionCount: number }>;
        render?: { rendered: boolean };
      };
    } catch (err) {
      await conn.rollback();
      // Deadlock retry: ER_LOCK_DEADLOCK (errno 1213)
      const isDeadlock =
        (err as Record<string, unknown>)?.errno === 1213 ||
        (err as Record<string, unknown>)?.code === "ER_LOCK_DEADLOCK";
      if (isDeadlock && retryCount < 1) {
        return this.ingest(tenantId, opts, retryCount + 1);
      }
      throw err;
    } finally {
      conn.release();
    }
  }
}
