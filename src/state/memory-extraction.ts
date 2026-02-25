/**
 * Memory Extraction — LLM-powered structured extraction from raw chat messages.
 *
 * Receives raw conversation messages (e.g. from botflow) and uses the
 * configured default model to extract profile updates, an episode summary,
 * and health concerns suitable for the Entity Memory `ingest()` pipeline.
 */

import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { getApiKeyForModel, requireApiKey } from "../agents/model-auth.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";
import { loadConfig } from "../config/io.js";

// ── Public types ────────────────────────────────────────────────────

export type RawMessage = {
  role: "caregiver" | "parent" | "system";
  content: string;
  timestamp?: string; // ISO 8601
};

export type ExtractionResult = {
  profileUpdates?: Record<string, unknown>;
  episodeSummary: string;
  concerns?: Array<{
    concernKey: string;
    displayName: string;
    severity: "low" | "medium" | "high" | "critical";
    evidenceText: string;
  }>;
};

// ── Prompt builder ──────────────────────────────────────────────────

export function buildExtractionPrompt(params: {
  messages: RawMessage[];
  channel: string;
  existingProfile?: Record<string, unknown> | null;
}): string {
  const profileSection = params.existingProfile
    ? JSON.stringify(params.existingProfile, null, 2)
    : "（无）";

  const conversationLines = params.messages
    .map((m) => {
      const ts = m.timestamp ? `[${m.timestamp}] ` : "";
      return `${ts}${m.role}: ${m.content}`;
    })
    .join("\n");

  return `你是一个早产儿照护数据分析助手。请分析以下对话记录，提取结构化信息。

## 已有家庭档案
${profileSection}

## 对话渠道
${params.channel}

## 对话记录
${conversationLines}

## 输出要求
请以 JSON 格式输出，包含以下字段：

1. **profileUpdates** — 从对话中发现的新事实。**必须且只能使用以下四个固定字段名**：
   - \`medical_facts\`: 数组，每项为 \`{"fact": "描述"}\`。用于记录医疗事实，包括：过敏、疾病诊断、用药情况、检查结果、医嘱等。
   - \`baby_snapshot\`: 对象，键值对形式。用于记录宝宝基本信息，包括：体重、身高、头围、矫正月龄、出生胎龄等。
   - \`feeding_profile\`: 对象，键值对形式。用于记录喂养情况，包括：喂养方式（母乳/配方奶/混合）、奶量、辅食添加情况等。
   - \`next_actions\`: 数组，每项为 \`{"fact": "描述"}\`。用于记录待办事项，包括：预约随访、复查安排、需要购买的物品等。
   - **不要使用上述四个以外的字段名**（如 medications、environment、sleepPosition 等都是错误的，应归入对应的正确字段）。
   - 仅输出新增/变化的信息，不要重复已有档案。如果没有新信息则省略 profileUpdates。

2. **episodeSummary** — 这段对话的简明摘要（100-200字）。

3. **concerns** — 发现的健康关注事项数组。每项包含 concernKey（英文标识如 "jaundice"）、displayName（中文名）、severity（low/medium/high/critical）、evidenceText（对话中的证据原文）。如果没有则省略。

仅输出 JSON，不要其他文字。`;
}

// ── JSON parsing & validation ───────────────────────────────────────

const VALID_SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const ALLOWED_PROFILE_KEYS = new Set([
  "medical_facts",
  "baby_snapshot",
  "feeding_profile",
  "next_actions",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateConcern(
  c: unknown,
  index: number,
): asserts c is ExtractionResult["concerns"] extends Array<infer T> ? T : never {
  if (!isPlainObject(c)) {
    throw new Error(`concerns[${index}] is not an object`);
  }
  if (!c.concernKey || typeof c.concernKey !== "string") {
    throw new Error(`concerns[${index}].concernKey must be a non-empty string`);
  }
  if (!c.displayName || typeof c.displayName !== "string") {
    throw new Error(`concerns[${index}].displayName must be a non-empty string`);
  }
  if (!VALID_SEVERITIES.has(c.severity as string)) {
    throw new Error(
      `concerns[${index}].severity must be one of: low, medium, high, critical (got "${String(c.severity)}")`,
    );
  }
  if (!c.evidenceText || typeof c.evidenceText !== "string") {
    throw new Error(`concerns[${index}].evidenceText must be a non-empty string`);
  }
}

/**
 * Normalize profileUpdates: move unrecognized top-level keys into medical_facts
 * so that assembleMemoryMarkdown can always render the data.
 */
export function normalizeProfileUpdates(raw: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  const spillover: Array<{ fact: string }> = [];

  for (const [key, value] of Object.entries(raw)) {
    if (ALLOWED_PROFILE_KEYS.has(key)) {
      normalized[key] = value;
    } else {
      // Unrecognized key → serialize into medical_facts as fallback
      const desc =
        typeof value === "string"
          ? value
          : typeof value === "object" && value !== null
            ? JSON.stringify(value, null, 0)
            : String(value);
      spillover.push({ fact: `${key}: ${desc}` });
    }
  }

  if (spillover.length > 0) {
    const existing = Array.isArray(normalized.medical_facts)
      ? (normalized.medical_facts as Array<{ fact: string }>)
      : [];
    normalized.medical_facts = [...existing, ...spillover];
  }

  return Object.keys(normalized).length > 0 ? normalized : {};
}

export function parseExtractionJson(text: string): ExtractionResult {
  // Strip markdown code fences if present
  const stripped = text
    .replace(/^```(?:json)?\n?/m, "")
    .replace(/\n?```$/m, "")
    .trim();
  const parsed = JSON.parse(stripped) as Record<string, unknown>;

  // episodeSummary — required, non-empty string
  if (!parsed.episodeSummary || typeof parsed.episodeSummary !== "string") {
    throw new Error("LLM extraction did not return episodeSummary");
  }

  // profileUpdates — optional, must be plain object if present
  if (parsed.profileUpdates !== undefined && parsed.profileUpdates !== null) {
    if (!isPlainObject(parsed.profileUpdates)) {
      throw new Error("profileUpdates must be a plain object (not array or primitive)");
    }
  }

  // concerns — optional, must be array of valid concern objects if present
  if (parsed.concerns !== undefined && parsed.concerns !== null) {
    if (!Array.isArray(parsed.concerns)) {
      throw new Error("concerns must be an array");
    }
    for (let i = 0; i < parsed.concerns.length; i++) {
      validateConcern(parsed.concerns[i], i);
    }
  }

  const profileRaw = isPlainObject(parsed.profileUpdates) ? parsed.profileUpdates : undefined;
  const profileNormalized = profileRaw ? normalizeProfileUpdates(profileRaw) : undefined;

  return {
    episodeSummary: parsed.episodeSummary,
    profileUpdates:
      profileNormalized && Object.keys(profileNormalized).length > 0
        ? profileNormalized
        : undefined,
    concerns: Array.isArray(parsed.concerns)
      ? (parsed.concerns as ExtractionResult["concerns"])
      : undefined,
  };
}

// ── Main extraction function ────────────────────────────────────────

export async function extractFromRawMessages(params: {
  messages: RawMessage[];
  channel: string;
  existingProfile?: Record<string, unknown> | null;
  signal?: AbortSignal;
}): Promise<ExtractionResult> {
  // 1. Resolve default model from config
  const cfg = loadConfig();
  const { provider, model: modelId } = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });

  // 2. Create Model object
  const resolved = resolveModel(provider, modelId, undefined, cfg);
  if (!resolved.model) {
    throw new Error(resolved.error ?? `Unknown model: ${provider}/${modelId}`);
  }

  // 3. Get API key
  const apiKey = requireApiKey(await getApiKeyForModel({ model: resolved.model, cfg }), provider);

  // 4. Call LLM
  const prompt = buildExtractionPrompt(params);
  const res = await completeSimple(
    resolved.model,
    {
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    },
    {
      apiKey,
      maxTokens: 2000,
      // Omit temperature — some models (e.g. kimi-k2.5) reject non-default values.
      signal: params.signal,
    },
  );

  // 5. Extract text content from response
  const text = res.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");

  // 6. Parse and validate
  return parseExtractionJson(text);
}
