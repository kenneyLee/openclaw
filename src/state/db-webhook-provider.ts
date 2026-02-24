import { randomBytes } from "node:crypto";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { WebhookConfig, WebhookProvider } from "./types.js";

const WEBHOOK_ID_PREFIX = "wh_";
const SIGNING_SECRET_PREFIX = "whsec_";

interface WebhookRow extends RowDataPacket {
  webhook_id: string;
  tenant_id: string;
  callback_url: string;
  signing_secret: string;
  agent_id: string;
}

interface WebhookListRow extends RowDataPacket {
  id: number;
  webhook_id: string;
  tenant_id: string;
  callback_url: string;
  agent_id: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface WebhookListItem {
  id: number;
  webhookId: string;
  tenantId: string;
  callbackUrl: string;
  agentId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export class DatabaseWebhookProvider implements WebhookProvider {
  constructor(private readonly pool: Pool) {}

  async resolveWebhook(tenantId: string): Promise<WebhookConfig | null> {
    const [rows] = await this.pool.execute<WebhookRow[]>(
      `SELECT webhook_id, tenant_id, callback_url, signing_secret, agent_id
         FROM tenant_webhooks
        WHERE tenant_id = ?
          AND enabled = 1
        LIMIT 1`,
      [tenantId],
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      webhookId: row.webhook_id,
      tenantId: row.tenant_id,
      callbackUrl: row.callback_url,
      signingSecret: row.signing_secret,
      agentId: row.agent_id,
    };
  }

  async createWebhook(params: {
    tenantId: string;
    callbackUrl: string;
    agentId?: string;
  }): Promise<{ webhookId: string; signingSecret: string }> {
    const webhookId = WEBHOOK_ID_PREFIX + randomBytes(16).toString("hex");
    const signingSecret = SIGNING_SECRET_PREFIX + randomBytes(24).toString("hex");
    await this.pool.execute(
      `INSERT INTO tenant_webhooks (tenant_id, webhook_id, callback_url, signing_secret, agent_id)
       VALUES (?, ?, ?, ?, ?)`,
      [params.tenantId, webhookId, params.callbackUrl, signingSecret, params.agentId ?? "main"],
    );
    return { webhookId, signingSecret };
  }

  async listWebhooks(tenantId?: string): Promise<WebhookListItem[]> {
    const query = tenantId
      ? "SELECT id, webhook_id, tenant_id, callback_url, agent_id, enabled, created_at, updated_at FROM tenant_webhooks WHERE tenant_id = ? ORDER BY id"
      : "SELECT id, webhook_id, tenant_id, callback_url, agent_id, enabled, created_at, updated_at FROM tenant_webhooks ORDER BY id";
    const params = tenantId ? [tenantId] : [];
    const [rows] = await this.pool.execute<WebhookListRow[]>(query, params);
    return rows.map((row) => ({
      id: row.id,
      webhookId: row.webhook_id,
      tenantId: row.tenant_id,
      callbackUrl: row.callback_url,
      agentId: row.agent_id,
      enabled: row.enabled === 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  async deleteWebhook(id: number): Promise<{ deleted: number }> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      "DELETE FROM tenant_webhooks WHERE id = ?",
      [id],
    );
    return { deleted: result.affectedRows };
  }
}
