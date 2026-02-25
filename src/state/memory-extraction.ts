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
1. profileUpdates — 从对话中发现的新事实（如宝宝体重变化、喂养量变化等）。仅输出新增/变化的字段，不要重复已有档案中的信息。如果没有新信息则省略此字段。
2. episodeSummary — 这段对话的简明摘要（100-200字）
3. concerns — 发现的健康关注事项数组。每项包含 concernKey（英文标识如 "jaundice"）、displayName（中文名）、severity（low/medium/high/critical）、evidenceText（对话中的证据原文）。如果没有则省略。

仅输出 JSON，不要其他文字。`;
}

// ── JSON parsing helper ─────────────────────────────────────────────

export function parseExtractionJson(text: string): ExtractionResult {
  // Strip markdown code fences if present
  const stripped = text
    .replace(/^```(?:json)?\n?/m, "")
    .replace(/\n?```$/m, "")
    .trim();
  const parsed = JSON.parse(stripped) as ExtractionResult;

  if (!parsed.episodeSummary || typeof parsed.episodeSummary !== "string") {
    throw new Error("LLM extraction did not return episodeSummary");
  }
  return parsed;
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
      temperature: 0.1,
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
