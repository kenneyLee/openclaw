import { createHash, randomBytes } from "node:crypto";
import type { Pool, RowDataPacket } from "mysql2/promise";
import type { ApiKeyProvider } from "./types.js";

const API_KEY_PREFIX = "osk_";

interface ApiKeyRow extends RowDataPacket {
  tenant_id: string;
  scopes: string | null;
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
}
