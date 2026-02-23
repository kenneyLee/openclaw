import { describe, expect, test } from "vitest";
import { MustacheTemplateEngine } from "../template-engine.js";

describe("MustacheTemplateEngine", () => {
  const engine = new MustacheTemplateEngine();

  test("renders simple variable substitution", () => {
    const result = engine.render("Hello {{name}}!", { name: "World" });
    expect(result).toBe("Hello World!");
  });

  test("renders section conditionals", () => {
    const tpl = "{{#premium}}Premium user{{/premium}}{{^premium}}Free user{{/premium}}";
    expect(engine.render(tpl, { premium: true })).toBe("Premium user");
    expect(engine.render(tpl, { premium: false })).toBe("Free user");
  });

  test("renders list iteration", () => {
    const tpl = "{{#items}}[{{.}}]{{/items}}";
    const result = engine.render(tpl, { items: ["a", "b", "c"] });
    expect(result).toBe("[a][b][c]");
  });

  test("renders missing variable as empty string", () => {
    const result = engine.render("Hello {{name}}!", {});
    expect(result).toBe("Hello !");
  });

  test("renders nested object properties", () => {
    const result = engine.render("{{baby.name}} is {{baby.months}} months", {
      baby: { name: "Mia", months: 3 },
    });
    expect(result).toBe("Mia is 3 months");
  });

  test("validate returns valid for correct template", () => {
    const result = engine.validate("Hello {{name}}!");
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("validate returns errors for malformed template", () => {
    const result = engine.validate("{{#open}} no close");
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toBeTruthy();
  });
});
