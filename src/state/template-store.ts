import type { Pool, RowDataPacket } from "mysql2/promise";

export interface Template {
  id: string;
  name: string;
  template: string;
  schema_json: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

interface TemplateRow extends RowDataPacket {
  id: string;
  name: string;
  template: string;
  schema_json: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

interface TenantTemplateRow extends RowDataPacket {
  tenant_id: string;
  template_data: Record<string, unknown> | null;
}

export class TemplateStore {
  constructor(private pool: Pool) {}

  async create(
    id: string,
    name: string,
    template: string,
    schemaJson?: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.execute(
      "INSERT INTO oc_templates (id, name, template, schema_json) VALUES (?, ?, ?, ?)",
      [id, name, template, schemaJson ? JSON.stringify(schemaJson) : null],
    );
  }

  async get(id: string): Promise<Template | null> {
    const [rows] = await this.pool.execute<TemplateRow[]>(
      "SELECT id, name, template, schema_json, created_at, updated_at FROM oc_templates WHERE id = ?",
      [id],
    );
    if (rows.length === 0) {
      return null;
    }
    const row = rows[0];
    return {
      id: row.id,
      name: row.name,
      template: row.template,
      schema_json:
        typeof row.schema_json === "string" ? JSON.parse(row.schema_json) : row.schema_json,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async list(): Promise<Template[]> {
    const [rows] = await this.pool.execute<TemplateRow[]>(
      "SELECT id, name, template, schema_json, created_at, updated_at FROM oc_templates ORDER BY created_at",
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      template: row.template,
      schema_json:
        typeof row.schema_json === "string" ? JSON.parse(row.schema_json) : row.schema_json,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  async update(id: string, template: string): Promise<void> {
    await this.pool.execute("UPDATE oc_templates SET template = ? WHERE id = ?", [template, id]);
  }

  async delete(id: string): Promise<void> {
    await this.pool.execute("DELETE FROM oc_templates WHERE id = ?", [id]);
  }

  async findTenantsByTemplate(
    templateId: string,
  ): Promise<{ tenant_id: string; template_data: Record<string, unknown> | null }[]> {
    const [rows] = await this.pool.execute<TenantTemplateRow[]>(
      "SELECT tenant_id, template_data FROM oc_tenants WHERE template_id = ?",
      [templateId],
    );
    return rows.map((row) => ({
      tenant_id: row.tenant_id,
      template_data:
        typeof row.template_data === "string" ? JSON.parse(row.template_data) : row.template_data,
    }));
  }
}
