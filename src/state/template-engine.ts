import Mustache from "mustache";

export interface TemplateEngine {
  render(template: string, data: Record<string, unknown>): string;
  validate(template: string): { valid: boolean; errors: string[] };
}

export class MustacheTemplateEngine implements TemplateEngine {
  render(template: string, data: Record<string, unknown>): string {
    return Mustache.render(template, data);
  }

  validate(template: string): { valid: boolean; errors: string[] } {
    try {
      Mustache.parse(template);
      return { valid: true, errors: [] };
    } catch (err) {
      return { valid: false, errors: [(err as Error).message] };
    }
  }
}
