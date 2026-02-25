import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { StateProvider } from "../state/types.js";
import { handleAdminEntityMemoryHttpRequest } from "./admin-entity-memory-http.js";

// ── Mocks ──────────────────────────────────────────────────────────────

vi.mock("./http-auth-helpers.js", () => ({
  authorizeGatewayBearerRequestOrReply: vi.fn().mockResolvedValue(true),
}));

vi.mock("./http-common.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./http-common.js")>();
  return {
    ...original,
    readJsonBodyOrError: vi.fn(),
  };
});

vi.mock("../state/memory-extraction.js", () => ({
  extractFromRawMessages: vi.fn(),
}));

const { readJsonBodyOrError } = await import("./http-common.js");
const { extractFromRawMessages } = await import("../state/memory-extraction.js");

// ── Helpers ────────────────────────────────────────────────────────────

function makeMockReq(urlPath: string, method = "POST"): IncomingMessage {
  return {
    url: urlPath,
    method,
    headers: { host: "localhost", "content-type": "application/json" },
  } as unknown as IncomingMessage;
}

function makeMockRes(): { res: ServerResponse; end: ReturnType<typeof vi.fn> } {
  const setHeader = vi.fn();
  const end = vi.fn();
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader,
    end,
  } as unknown as ServerResponse;
  return { res, end };
}

function parseResponseBody(end: ReturnType<typeof vi.fn>): unknown {
  const raw = end.mock.calls[0]?.[0];
  return typeof raw === "string" ? JSON.parse(raw) : undefined;
}

const mockIngest = vi.fn().mockResolvedValue({
  profile: { updated: true, newVersion: 2 },
  episode: { id: 42 },
  render: { rendered: true },
});

const mockGetProfile = vi.fn().mockResolvedValue({
  tenantId: "t1",
  profileData: { baby_name: "宝宝" },
  version: 1,
  lastInteractionAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

const mockEntityMemory = {
  getProfile: mockGetProfile,
  ingest: mockIngest,
  getEpisodesSince: vi.fn().mockResolvedValue([]),
  getAllConcerns: vi.fn().mockResolvedValue([]),
  getActiveConcerns: vi.fn().mockResolvedValue([]),
};

const mockStateProvider = {
  entityMemory: mockEntityMemory,
} as unknown as StateProvider;

const baseOpts = {
  auth: { mode: "none" as const, allowTailscale: false },
  stateProvider: mockStateProvider,
};

const sampleMessages = [
  { role: "parent", content: "宝宝今天体重到4.2kg了", timestamp: "2026-02-25T10:30:00Z" },
  { role: "caregiver", content: "很好！比上周增长了200g", timestamp: "2026-02-25T10:31:00Z" },
];

const sampleExtraction = {
  profileUpdates: { baby_weight_kg: 4.2 },
  episodeSummary: "家长反馈宝宝体重增长至4.2kg，较上周增长200g。照护师确认增长良好。",
  concerns: [],
};

// ── Tests ──────────────────────────────────────────────────────────────

describe("admin-entity-memory-http /ingest-raw", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProfile.mockResolvedValue({
      tenantId: "t1",
      profileData: { baby_name: "宝宝" },
      version: 1,
      lastInteractionAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    mockIngest.mockResolvedValue({
      profile: { updated: true, newVersion: 2 },
      episode: { id: 42 },
      render: { rendered: true },
    });
  });

  test("returns 400 when tenantId is missing", async () => {
    vi.mocked(readJsonBodyOrError).mockResolvedValue({
      channel: "easemob",
      messages: sampleMessages,
    });
    const { res, end } = makeMockRes();
    await handleAdminEntityMemoryHttpRequest(
      makeMockReq("/v1/admin/memory/ingest-raw"),
      res,
      baseOpts,
    );
    expect(res.statusCode).toBe(400);
    const body = parseResponseBody(end) as { error?: { message?: string } };
    expect(body.error?.message).toContain("tenantId is required");
  });

  test("returns 400 when channel is missing", async () => {
    vi.mocked(readJsonBodyOrError).mockResolvedValue({
      tenantId: "t1",
      messages: sampleMessages,
    });
    const { res, end } = makeMockRes();
    await handleAdminEntityMemoryHttpRequest(
      makeMockReq("/v1/admin/memory/ingest-raw"),
      res,
      baseOpts,
    );
    expect(res.statusCode).toBe(400);
    const body = parseResponseBody(end) as { error?: { message?: string } };
    expect(body.error?.message).toContain("channel is required");
  });

  test("returns 400 when messages is empty", async () => {
    vi.mocked(readJsonBodyOrError).mockResolvedValue({
      tenantId: "t1",
      channel: "easemob",
      messages: [],
    });
    const { res, end } = makeMockRes();
    await handleAdminEntityMemoryHttpRequest(
      makeMockReq("/v1/admin/memory/ingest-raw"),
      res,
      baseOpts,
    );
    expect(res.statusCode).toBe(400);
    const body = parseResponseBody(end) as { error?: { message?: string } };
    expect(body.error?.message).toContain("messages must be a non-empty array");
  });

  test("returns 400 when messages is not an array", async () => {
    vi.mocked(readJsonBodyOrError).mockResolvedValue({
      tenantId: "t1",
      channel: "easemob",
      messages: "not an array",
    });
    const { res, end } = makeMockRes();
    await handleAdminEntityMemoryHttpRequest(
      makeMockReq("/v1/admin/memory/ingest-raw"),
      res,
      baseOpts,
    );
    expect(res.statusCode).toBe(400);
    const body = parseResponseBody(end) as { error?: { message?: string } };
    expect(body.error?.message).toContain("messages must be a non-empty array");
  });

  test("calls extractFromRawMessages and ingest on success", async () => {
    vi.mocked(readJsonBodyOrError).mockResolvedValue({
      tenantId: "t1",
      channel: "easemob",
      messages: sampleMessages,
      source: "botflow",
    });
    vi.mocked(extractFromRawMessages).mockResolvedValue(sampleExtraction);

    const { res, end } = makeMockRes();
    await handleAdminEntityMemoryHttpRequest(
      makeMockReq("/v1/admin/memory/ingest-raw"),
      res,
      baseOpts,
    );

    expect(res.statusCode).toBe(200);
    const body = parseResponseBody(end) as {
      ok?: boolean;
      extraction?: typeof sampleExtraction;
      results?: unknown;
    };
    expect(body.ok).toBe(true);
    expect(body.extraction?.episodeSummary).toBe(sampleExtraction.episodeSummary);

    // Verify extractFromRawMessages was called with existing profile data
    expect(vi.mocked(extractFromRawMessages)).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: sampleMessages,
        channel: "easemob",
        existingProfile: { baby_name: "宝宝" },
      }),
    );

    // Verify ingest was called with extracted data
    expect(mockIngest).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        episode: expect.objectContaining({
          episodeType: "conversation",
          channel: "easemob",
          content: sampleExtraction.episodeSummary,
          metadata: { source: "botflow", rawMessageCount: 2 },
        }),
        profileUpdates: { baby_weight_kg: 4.2 },
        render: true,
      }),
    );
  });

  test("falls back to raw content when extraction fails", async () => {
    vi.mocked(readJsonBodyOrError).mockResolvedValue({
      tenantId: "t1",
      channel: "easemob",
      messages: sampleMessages,
      source: "botflow",
    });
    vi.mocked(extractFromRawMessages).mockRejectedValue(new Error("Model API returned 429"));

    const { res, end } = makeMockRes();
    await handleAdminEntityMemoryHttpRequest(
      makeMockReq("/v1/admin/memory/ingest-raw"),
      res,
      baseOpts,
    );

    expect(res.statusCode).toBe(200);
    const body = parseResponseBody(end) as {
      ok?: boolean;
      extractionFailed?: boolean;
      extractionError?: string;
      results?: unknown;
    };
    expect(body.ok).toBe(true);
    expect(body.extractionFailed).toBe(true);
    expect(body.extractionError).toContain("429");

    // Verify ingest was called with fallback content
    expect(mockIngest).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        episode: expect.objectContaining({
          episodeType: "conversation",
          channel: "easemob",
          metadata: expect.objectContaining({ extractionFailed: true }),
        }),
        render: true,
      }),
    );
  });

  test("includes concerns with source in ingest call", async () => {
    const extractionWithConcerns = {
      episodeSummary: "宝宝黄疸值偏高",
      concerns: [
        {
          concernKey: "jaundice",
          displayName: "黄疸偏高",
          severity: "high" as const,
          evidenceText: "黄疸值15",
        },
      ],
    };
    vi.mocked(readJsonBodyOrError).mockResolvedValue({
      tenantId: "t1",
      channel: "easemob",
      messages: sampleMessages,
      source: "botflow",
    });
    vi.mocked(extractFromRawMessages).mockResolvedValue(extractionWithConcerns);

    const { res } = makeMockRes();
    await handleAdminEntityMemoryHttpRequest(
      makeMockReq("/v1/admin/memory/ingest-raw"),
      res,
      baseOpts,
    );

    expect(mockIngest).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        concerns: [
          expect.objectContaining({
            concernKey: "jaundice",
            source: "botflow",
          }),
        ],
      }),
    );
  });

  test("uses default source when not provided", async () => {
    vi.mocked(readJsonBodyOrError).mockResolvedValue({
      tenantId: "t1",
      channel: "easemob",
      messages: sampleMessages,
    });
    vi.mocked(extractFromRawMessages).mockResolvedValue(sampleExtraction);

    const { res } = makeMockRes();
    await handleAdminEntityMemoryHttpRequest(
      makeMockReq("/v1/admin/memory/ingest-raw"),
      res,
      baseOpts,
    );

    expect(mockIngest).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        episode: expect.objectContaining({
          metadata: expect.objectContaining({ source: "ingest-raw" }),
        }),
      }),
    );
  });

  test("proceeds when getProfile fails", async () => {
    mockGetProfile.mockRejectedValue(new Error("DB down"));
    vi.mocked(readJsonBodyOrError).mockResolvedValue({
      tenantId: "t1",
      channel: "easemob",
      messages: sampleMessages,
    });
    vi.mocked(extractFromRawMessages).mockResolvedValue(sampleExtraction);

    const { res } = makeMockRes();
    await handleAdminEntityMemoryHttpRequest(
      makeMockReq("/v1/admin/memory/ingest-raw"),
      res,
      baseOpts,
    );

    expect(res.statusCode).toBe(200);
    // Extraction should have been called with null profile
    expect(vi.mocked(extractFromRawMessages)).toHaveBeenCalledWith(
      expect.objectContaining({ existingProfile: null }),
    );
  });

  test("respects render=false", async () => {
    vi.mocked(readJsonBodyOrError).mockResolvedValue({
      tenantId: "t1",
      channel: "easemob",
      messages: sampleMessages,
      render: false,
    });
    vi.mocked(extractFromRawMessages).mockResolvedValue(sampleExtraction);

    const { res } = makeMockRes();
    await handleAdminEntityMemoryHttpRequest(
      makeMockReq("/v1/admin/memory/ingest-raw"),
      res,
      baseOpts,
    );

    expect(mockIngest).toHaveBeenCalledWith("t1", expect.objectContaining({ render: false }));
  });

  test("does not route non-POST requests", async () => {
    const { res } = makeMockRes();
    await handleAdminEntityMemoryHttpRequest(
      makeMockReq("/v1/admin/memory/ingest-raw", "GET"),
      res,
      baseOpts,
    );
    // The handler should not match GET for this path — it falls through
    // to subsequent route checks. readJsonBodyOrError should not have been called.
    expect(vi.mocked(readJsonBodyOrError)).not.toHaveBeenCalled();
  });
});
