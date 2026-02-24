/**
 * Database Tenant Provider
 *
 * CRUD operations for the oc_tenants registry table.
 */

import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

export interface Tenant {
  tenantId: string;
  name: string;
  templateId: string | null;
  templateData: Record<string, unknown> | null;
  status: "active" | "suspended";
  createdAt: string;
  updatedAt: string;
}

interface TenantRow extends RowDataPacket {
  tenant_id: string;
  name: string;
  template_id: string | null;
  template_data: Record<string, unknown> | string | null;
  status: "active" | "suspended";
  created_at: string;
  updated_at: string;
}

function rowToTenant(row: TenantRow): Tenant {
  return {
    tenantId: row.tenant_id,
    name: row.name,
    templateId: row.template_id,
    templateData:
      typeof row.template_data === "string" ? JSON.parse(row.template_data) : row.template_data,
    status: row.status,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class DatabaseTenantProvider {
  constructor(private readonly pool: Pool) {}

  async create(params: {
    tenantId: string;
    name?: string;
    templateId?: string;
    templateData?: Record<string, unknown>;
  }): Promise<Tenant> {
    await this.pool.execute(
      `INSERT INTO oc_tenants (tenant_id, name, template_id, template_data)
       VALUES (?, ?, ?, ?)`,
      [
        params.tenantId,
        params.name ?? "",
        params.templateId ?? null,
        params.templateData ? JSON.stringify(params.templateData) : null,
      ],
    );
    const tenant = await this.get(params.tenantId);
    return tenant!;
  }

  async get(tenantId: string): Promise<Tenant | null> {
    const [rows] = await this.pool.execute<TenantRow[]>(
      "SELECT tenant_id, name, template_id, template_data, status, created_at, updated_at FROM oc_tenants WHERE tenant_id = ?",
      [tenantId],
    );
    if (rows.length === 0) {
      return null;
    }
    return rowToTenant(rows[0]);
  }

  async list(): Promise<Tenant[]> {
    const [rows] = await this.pool.execute<TenantRow[]>(
      "SELECT tenant_id, name, template_id, template_data, status, created_at, updated_at FROM oc_tenants ORDER BY created_at DESC",
    );
    return rows.map(rowToTenant);
  }

  async update(
    tenantId: string,
    params: {
      name?: string;
      templateId?: string | null;
      templateData?: Record<string, unknown> | null;
      status?: "active" | "suspended";
    },
  ): Promise<{ updated: number }> {
    const sets: string[] = [];
    const values: (string | null)[] = [];

    if (params.name !== undefined) {
      sets.push("name = ?");
      values.push(params.name);
    }
    if (params.templateId !== undefined) {
      sets.push("template_id = ?");
      values.push(params.templateId);
    }
    if (params.templateData !== undefined) {
      sets.push("template_data = ?");
      values.push(params.templateData ? JSON.stringify(params.templateData) : null);
    }
    if (params.status !== undefined) {
      sets.push("status = ?");
      values.push(params.status);
    }

    if (sets.length === 0) {
      return { updated: 0 };
    }

    values.push(tenantId);
    const sql = `UPDATE oc_tenants SET ${sets.join(", ")} WHERE tenant_id = ?`;
    const [result] = await this.pool.execute<ResultSetHeader>({ sql }, values);
    return { updated: result.affectedRows };
  }
}
