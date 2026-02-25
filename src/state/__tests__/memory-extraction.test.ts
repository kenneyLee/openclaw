import { completeSimple, type AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, test, vi, beforeEach } from "vitest";
import {
  buildExtractionPrompt,
  extractFromRawMessages,
  parseExtractionJson,
  type RawMessage,
} from "../memory-extraction.js";

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: vi.fn(),
  getOAuthProviders: () => [],
  getOAuthApiKey: vi.fn(async () => null),
}));

vi.mock("../../agents/pi-embedded-runner/model.js", () => ({
  resolveModel: vi.fn(() => ({
    model: {
      provider: "anthropic",
      id: "claude-opus-4-6",
      name: "claude-opus-4-6",
      api: "anthropic-messages",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    },
    authStorage: { profiles: {} },
    modelRegistry: { find: vi.fn() },
  })),
}));

vi.mock("../../agents/model-auth.js", () => ({
  getApiKeyForModel: vi.fn(async () => ({
    apiKey: "test-api-key",
    source: "test",
    mode: "api-key",
  })),
  requireApiKey: vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? ""),
}));

vi.mock("../../config/io.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

// ── Helpers ─────────────────────────────────────────────────────────

const mockAssistantMessage = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-opus-4-6",
  usage: {
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 150,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

const sampleMessages: RawMessage[] = [
  { role: "parent", content: "宝宝今天体重到4.2kg了", timestamp: "2026-02-25T10:30:00Z" },
  { role: "caregiver", content: "很好！比上周增长了200g", timestamp: "2026-02-25T10:31:00Z" },
];

const sampleExtraction = {
  profileUpdates: { baby_weight_kg: 4.2 },
  episodeSummary: "家长反馈宝宝体重增长至4.2kg，较上周增长200g。照护师确认增长良好。",
  concerns: [],
};

// ── Tests: buildExtractionPrompt ────────────────────────────────────

describe("buildExtractionPrompt", () => {
  test("includes messages and channel in prompt", () => {
    const prompt = buildExtractionPrompt({
      messages: sampleMessages,
      channel: "easemob",
    });
    expect(prompt).toContain("easemob");
    expect(prompt).toContain("宝宝今天体重到4.2kg了");
    expect(prompt).toContain("比上周增长了200g");
    expect(prompt).toContain("[2026-02-25T10:30:00Z] parent:");
  });

  test("includes existing profile when provided", () => {
    const prompt = buildExtractionPrompt({
      messages: sampleMessages,
      channel: "im",
      existingProfile: { baby_name: "小明", baby_weight_kg: 4.0 },
    });
    expect(prompt).toContain('"baby_name": "小明"');
    expect(prompt).toContain('"baby_weight_kg": 4');
  });

  test("shows placeholder when no existing profile", () => {
    const prompt = buildExtractionPrompt({
      messages: sampleMessages,
      channel: "im",
      existingProfile: null,
    });
    expect(prompt).toContain("（无）");
  });

  test("handles messages without timestamp", () => {
    const prompt = buildExtractionPrompt({
      messages: [{ role: "parent", content: "你好" }],
      channel: "im",
    });
    expect(prompt).toContain("parent: 你好");
    expect(prompt).not.toContain("[undefined]");
  });
});

// ── Tests: parseExtractionJson ──────────────────────────────────────

describe("parseExtractionJson", () => {
  test("parses plain JSON", () => {
    const json = JSON.stringify(sampleExtraction);
    const result = parseExtractionJson(json);
    expect(result.episodeSummary).toBe(sampleExtraction.episodeSummary);
    expect(result.profileUpdates).toEqual({ baby_weight_kg: 4.2 });
  });

  test("handles markdown code fence wrapping", () => {
    const json = "```json\n" + JSON.stringify(sampleExtraction) + "\n```";
    const result = parseExtractionJson(json);
    expect(result.episodeSummary).toBe(sampleExtraction.episodeSummary);
  });

  test("handles code fence without json language tag", () => {
    const json = "```\n" + JSON.stringify(sampleExtraction) + "\n```";
    const result = parseExtractionJson(json);
    expect(result.episodeSummary).toBe(sampleExtraction.episodeSummary);
  });

  test("throws when episodeSummary is missing", () => {
    const json = JSON.stringify({ profileUpdates: {} });
    expect(() => parseExtractionJson(json)).toThrow("episodeSummary");
  });

  test("throws when episodeSummary is not a string", () => {
    const json = JSON.stringify({ episodeSummary: 123 });
    expect(() => parseExtractionJson(json)).toThrow("episodeSummary");
  });

  test("throws on invalid JSON", () => {
    expect(() => parseExtractionJson("not json")).toThrow();
  });

  test("preserves concerns array", () => {
    const data = {
      episodeSummary: "摘要",
      concerns: [
        {
          concernKey: "jaundice",
          displayName: "黄疸",
          severity: "high",
          evidenceText: "黄疸值15",
        },
      ],
    };
    const result = parseExtractionJson(JSON.stringify(data));
    expect(result.concerns).toHaveLength(1);
    expect(result.concerns![0].concernKey).toBe("jaundice");
  });

  // ── Schema validation: profileUpdates ──

  test("throws when profileUpdates is an array", () => {
    const json = JSON.stringify({ episodeSummary: "摘要", profileUpdates: [1, 2] });
    expect(() => parseExtractionJson(json)).toThrow("profileUpdates must be a plain object");
  });

  test("throws when profileUpdates is a string", () => {
    const json = JSON.stringify({ episodeSummary: "摘要", profileUpdates: "bad" });
    expect(() => parseExtractionJson(json)).toThrow("profileUpdates must be a plain object");
  });

  test("allows null profileUpdates (treated as absent)", () => {
    const json = JSON.stringify({ episodeSummary: "摘要", profileUpdates: null });
    const result = parseExtractionJson(json);
    expect(result.profileUpdates).toBeUndefined();
  });

  // ── Schema validation: concerns ──

  test("throws when concerns is not an array", () => {
    const json = JSON.stringify({ episodeSummary: "摘要", concerns: "bad" });
    expect(() => parseExtractionJson(json)).toThrow("concerns must be an array");
  });

  test("throws when concern is missing concernKey", () => {
    const json = JSON.stringify({
      episodeSummary: "摘要",
      concerns: [{ displayName: "黄疸", severity: "high", evidenceText: "值15" }],
    });
    expect(() => parseExtractionJson(json)).toThrow(
      "concerns[0].concernKey must be a non-empty string",
    );
  });

  test("throws when concern has empty displayName", () => {
    const json = JSON.stringify({
      episodeSummary: "摘要",
      concerns: [
        { concernKey: "jaundice", displayName: "", severity: "high", evidenceText: "值15" },
      ],
    });
    expect(() => parseExtractionJson(json)).toThrow(
      "concerns[0].displayName must be a non-empty string",
    );
  });

  test("throws when concern has invalid severity", () => {
    const json = JSON.stringify({
      episodeSummary: "摘要",
      concerns: [
        { concernKey: "jaundice", displayName: "黄疸", severity: "urgent", evidenceText: "值15" },
      ],
    });
    expect(() => parseExtractionJson(json)).toThrow("concerns[0].severity must be one of");
    expect(() => parseExtractionJson(json)).toThrow('"urgent"');
  });

  test("throws when concern has missing evidenceText", () => {
    const json = JSON.stringify({
      episodeSummary: "摘要",
      concerns: [{ concernKey: "jaundice", displayName: "黄疸", severity: "high" }],
    });
    expect(() => parseExtractionJson(json)).toThrow(
      "concerns[0].evidenceText must be a non-empty string",
    );
  });

  test("throws when concern item is not an object", () => {
    const json = JSON.stringify({ episodeSummary: "摘要", concerns: ["bad"] });
    expect(() => parseExtractionJson(json)).toThrow("concerns[0] is not an object");
  });

  test("reports correct index for invalid concern in middle of array", () => {
    const json = JSON.stringify({
      episodeSummary: "摘要",
      concerns: [
        { concernKey: "ok", displayName: "OK", severity: "low", evidenceText: "fine" },
        { concernKey: "", displayName: "坏的", severity: "low", evidenceText: "bad" },
      ],
    });
    expect(() => parseExtractionJson(json)).toThrow(
      "concerns[1].concernKey must be a non-empty string",
    );
  });
});

// ── Tests: extractFromRawMessages ───────────────────────────────────

describe("extractFromRawMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("extracts profile updates, episode summary, and concerns", async () => {
    vi.mocked(completeSimple).mockResolvedValue(
      mockAssistantMessage([{ type: "text", text: JSON.stringify(sampleExtraction) }]),
    );

    const result = await extractFromRawMessages({
      messages: sampleMessages,
      channel: "easemob",
    });

    expect(result.episodeSummary).toBe(sampleExtraction.episodeSummary);
    expect(result.profileUpdates).toEqual({ baby_weight_kg: 4.2 });
    expect(vi.mocked(completeSimple)).toHaveBeenCalledOnce();
  });

  test("handles LLM returning markdown code fence", async () => {
    const wrapped = "```json\n" + JSON.stringify(sampleExtraction) + "\n```";
    vi.mocked(completeSimple).mockResolvedValue(
      mockAssistantMessage([{ type: "text", text: wrapped }]),
    );

    const result = await extractFromRawMessages({
      messages: sampleMessages,
      channel: "easemob",
    });

    expect(result.episodeSummary).toBe(sampleExtraction.episodeSummary);
  });

  test("throws when episodeSummary is missing from LLM output", async () => {
    vi.mocked(completeSimple).mockResolvedValue(
      mockAssistantMessage([{ type: "text", text: JSON.stringify({ profileUpdates: {} }) }]),
    );

    await expect(
      extractFromRawMessages({ messages: sampleMessages, channel: "easemob" }),
    ).rejects.toThrow("episodeSummary");
  });

  test("works without existing profile", async () => {
    vi.mocked(completeSimple).mockResolvedValue(
      mockAssistantMessage([{ type: "text", text: JSON.stringify(sampleExtraction) }]),
    );

    const result = await extractFromRawMessages({
      messages: sampleMessages,
      channel: "easemob",
      existingProfile: null,
    });

    expect(result.episodeSummary).toBeTruthy();
    // Verify the prompt included the "（无）" placeholder
    const callArgs = vi.mocked(completeSimple).mock.calls[0];
    const promptContent = (callArgs[1].messages[0] as { content: string }).content;
    expect(promptContent).toContain("（无）");
  });

  test("passes existing profile to prompt for deduplication", async () => {
    vi.mocked(completeSimple).mockResolvedValue(
      mockAssistantMessage([{ type: "text", text: JSON.stringify(sampleExtraction) }]),
    );

    const existingProfile = { baby_name: "小明", baby_weight_kg: 4.0 };
    await extractFromRawMessages({
      messages: sampleMessages,
      channel: "easemob",
      existingProfile,
    });

    const callArgs = vi.mocked(completeSimple).mock.calls[0];
    const promptContent = (callArgs[1].messages[0] as { content: string }).content;
    expect(promptContent).toContain('"baby_name": "小明"');
    expect(promptContent).toContain('"baby_weight_kg": 4');
  });

  test("does not set temperature (model compatibility)", async () => {
    vi.mocked(completeSimple).mockResolvedValue(
      mockAssistantMessage([{ type: "text", text: JSON.stringify(sampleExtraction) }]),
    );

    await extractFromRawMessages({ messages: sampleMessages, channel: "im" });

    const callArgs = vi.mocked(completeSimple).mock.calls[0];
    expect(callArgs[2]!.temperature).toBeUndefined();
  });
});
