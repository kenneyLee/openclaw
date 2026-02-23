import type { Pool, RowDataPacket } from "mysql2/promise";
import type { WorkspaceBootstrapFile, WorkspaceBootstrapFileName } from "../agents/workspace.js";
import type { BootstrapFileProvider, BootstrapLoadContext } from "./types.js";

interface BootstrapRow extends RowDataPacket {
  file_name: string;
  content: string;
}

export class DatabaseBootstrapProvider implements BootstrapFileProvider {
  constructor(private pool: Pool) {}

  async loadBootstrapFiles(ctx: BootstrapLoadContext): Promise<WorkspaceBootstrapFile[]> {
    const tenantId = ctx.tenantId ?? ctx.agentId;
    if (!tenantId) {
      throw new Error("DatabaseBootstrapProvider requires tenantId or agentId");
    }

    const [rows] = await this.pool.execute<BootstrapRow[]>(
      "SELECT file_name, content FROM tenant_bootstrap_files WHERE tenant_id = ?",
      [tenantId],
    );

    return rows.map((row) => ({
      name: row.file_name as WorkspaceBootstrapFileName,
      path: `db://${tenantId}/${row.file_name}`,
      content: row.content,
      missing: false,
    }));
  }

  async loadExtraBootstrapFiles(
    _ctx: BootstrapLoadContext,
    _extraPatterns: string[],
  ): Promise<WorkspaceBootstrapFile[]> {
    // Extra bootstrap files use glob patterns on the file system,
    // not applicable in DB mode — return empty array.
    return [];
  }
}
