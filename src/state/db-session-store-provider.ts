import type { Pool, RowDataPacket } from "mysql2/promise";
import type { SessionEntry } from "../config/sessions/types.js";
import type { SessionStoreProvider } from "./types.js";

interface SessionRow extends RowDataPacket {
  session_key: string;
  session_data: string;
}

export class DatabaseSessionStoreProvider implements SessionStoreProvider {
  constructor(private pool: Pool) {}

  async loadSessionStore(
    storePath: string,
    _opts?: { skipCache?: boolean },
  ): Promise<Record<string, SessionEntry>> {
    const [rows] = await this.pool.execute<SessionRow[]>(
      "SELECT session_key, session_data FROM tenant_sessions WHERE store_path = ?",
      [storePath],
    );

    const store: Record<string, SessionEntry> = {};
    for (const row of rows) {
      const data =
        typeof row.session_data === "string" ? JSON.parse(row.session_data) : row.session_data;
      store[row.session_key] = data as SessionEntry;
    }
    return store;
  }

  async saveSessionStore(storePath: string, store: Record<string, SessionEntry>): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      // Remove all existing entries for this storePath, then insert fresh.
      await conn.execute("DELETE FROM tenant_sessions WHERE store_path = ?", [storePath]);

      const entries = Object.entries(store);
      if (entries.length > 0) {
        const sql = "INSERT INTO tenant_sessions (store_path, session_key, session_data) VALUES ?";
        const values = entries.map(([key, entry]) => [storePath, key, JSON.stringify(entry)]);
        await conn.query(sql, [values]);
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async updateSessionStore<T>(
    storePath: string,
    mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
  ): Promise<T> {
    const store = await this.loadSessionStore(storePath, { skipCache: true });
    const result = await mutator(store);
    await this.saveSessionStore(storePath, store);
    return result;
  }
}
