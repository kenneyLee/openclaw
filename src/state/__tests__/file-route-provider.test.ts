import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { FileRouteProvider } from "../file-route-provider.js";

describe("FileRouteProvider", () => {
  const provider = new FileRouteProvider();

  test("returns same result as direct resolveAgentRoute call", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "sales",
          match: {
            channel: "whatsapp",
            peer: { kind: "direct", id: "+15551234567" },
          },
        },
      ],
    };
    const input = {
      cfg,
      channel: "whatsapp",
      accountId: null,
      peer: { kind: "direct" as const, id: "+15551234567" },
    };

    const providerResult = provider.resolveAgentRoute(input);
    const directResult = resolveAgentRoute(input);

    expect(providerResult).toEqual(directResult);
  });

  test("returns default route when no binding matches", () => {
    const cfg: OpenClawConfig = {};
    const result = provider.resolveAgentRoute({
      cfg,
      channel: "telegram",
      accountId: null,
      peer: { kind: "direct", id: "12345" },
    });

    expect(result.agentId).toBe("main");
    expect(result.matchedBy).toBe("default");
  });

  test("returns matched agent when binding exists", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "support",
          match: {
            channel: "discord",
            peer: { kind: "channel", id: "c-100" },
          },
        },
      ],
    };
    const result = provider.resolveAgentRoute({
      cfg,
      channel: "discord",
      accountId: null,
      peer: { kind: "channel", id: "c-100" },
    });

    expect(result.agentId).toBe("support");
    expect(result.matchedBy).toBe("binding.peer");
  });
});
