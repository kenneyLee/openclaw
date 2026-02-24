import { createHash, randomBytes } from "node:crypto";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { ApiKeyProvider } from "./types.js";

const API_KEY_PREFIX = "osk_";

interface ApiKeyRow extends RowDataPacket {
  tenant_id: string;
  scopes: string | null;
}

interface ApiKeyListRow extends RowDataPacket {
  id: number;
  tenant_id: string;
  label: string | null;
  scopes: string | null;
  enabled: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiKeyListItem {
  id: number;
  tenantId: string;
  label: string | null;
  scopes: string[] | null;
  enabled: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export class DatabaseApiKeyProvider implements ApiKeyProvider {
  constructor(private readonly pool: Pool) {}

  async resolveApiKey(
    rawKey: string,
  ): Promise<{ tenantId: string; scopes: string[] | null } | null> {
    if (!rawKey.startsWith(API_KEY_PREFIX)) {
      return null;
    }
    const hash = hashApiKey(rawKey);
    const [rows] = await this.pool.execute<ApiKeyRow[]>(
      `SELECT tenant_id, scopes
         FROM tenant_api_keys
        WHERE api_key_hash = ?
          AND enabled = 1
          AND (expires_at IS NULL OR expires_at > NOW())`,
      [hash],
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    let scopes: string[] | null = null;
    if (row.scopes) {
      try {
        const parsed = JSON.parse(row.scopes);
        if (Array.isArray(parsed)) {
          scopes = parsed as string[];
        }
      } catch {
        // treat invalid JSON as null (all scopes)
      }
    }
    return { tenantId: row.tenant_id, scopes };
  }

  async createApiKey(params: {
    tenantId: string;
    label?: string;
    scopes?: string[] | null;
  }): Promise<{ apiKey: string; hash: string }> {
    const raw = API_KEY_PREFIX + randomBytes(32).toString("hex");
    const hash = hashApiKey(raw);
    await this.pool.execute(
      `INSERT INTO tenant_api_keys (api_key_hash, tenant_id, label, scopes)
       VALUES (?, ?, ?, ?)`,
      [
        hash,
        params.tenantId,
        params.label ?? null,
        params.scopes ? JSON.stringify(params.scopes) : null,
      ],
    );
    return { apiKey: raw, hash };
  }

  async listApiKeys(tenantId?: string): Promise<ApiKeyListItem[]> {
    const query = tenantId
      ? "SELECT id, tenant_id, label, scopes, enabled, expires_at, created_at, updated_at FROM tenant_api_keys WHERE tenant_id = ? ORDER BY id"
      : "SELECT id, tenant_id, label, scopes, enabled, expires_at, created_at, updated_at FROM tenant_api_keys ORDER BY id";
    const params = tenantId ? [tenantId] : [];
    const [rows] = await this.pool.execute<ApiKeyListRow[]>(query, params);
    return rows.map((row) => {
      let scopes: string[] | null = null;
      if (row.scopes) {
        try {
          const parsed = JSON.parse(row.scopes);
          if (Array.isArray(parsed)) {
            scopes = parsed as string[];
          }
        } catch {
          // treat invalid JSON as null
        }
      }
      return {
        id: row.id,
        tenantId: row.tenant_id,
        label: row.label,
        scopes,
        enabled: row.enabled === 1,
        expiresAt: row.expires_at ? String(row.expires_at) : null,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      };
    });
  }

  async disableApiKey(id: number): Promise<{ updated: number }> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      "UPDATE tenant_api_keys SET enabled = 0 WHERE id = ?",
      [id],
    );
    return { updated: result.affectedRows };
  }
}
