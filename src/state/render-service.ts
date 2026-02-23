import type { Pool } from "mysql2/promise";
import type { TemplateEngine } from "./template-engine.js";
import type { TemplateStore } from "./template-store.js";

export class RenderService {
  constructor(
    private pool: Pool,
    private store: TemplateStore,
    private engine: TemplateEngine,
  ) {}

  async renderTenant(
    tenantId: string,
    templateId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const tpl = await this.store.get(templateId);
    if (!tpl) {
      throw new Error(`Template not found: ${templateId}`);
    }

    const rendered = this.engine.render(tpl.template, data);

    await this.pool.execute(
      `INSERT INTO tenant_bootstrap_files (tenant_id, file_name, content)
       VALUES (?, 'SOUL.md', ?)
       ON DUPLICATE KEY UPDATE content = VALUES(content), updated_at = CURRENT_TIMESTAMP`,
      [tenantId, rendered],
    );
  }

  async reRenderByTemplate(
    templateId: string,
  ): Promise<{ count: number; errors: { tenantId: string; error: string }[] }> {
    const tenants = await this.store.findTenantsByTemplate(templateId);
    let count = 0;
    const errors: { tenantId: string; error: string }[] = [];

    for (const tenant of tenants) {
      try {
        await this.renderTenant(tenant.tenant_id, templateId, tenant.template_data ?? {});
        count++;
      } catch (err) {
        errors.push({
          tenantId: tenant.tenant_id,
          error: (err as Error).message,
        });
      }
    }

    return { count, errors };
  }
}
