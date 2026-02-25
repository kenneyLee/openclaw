import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, test, vi } from "vitest";
import type { StateProvider } from "../state/types.js";
import { handleAdminEntityMemoryHttpRequest } from "./admin-entity-memory-http.js";

// ── Mocks ──────────────────────────────────────────────────────────────

vi.mock("./http-auth-helpers.js", () => ({
  authorizeGatewayBearerRequestOrReply: vi.fn().mockResolvedValue(true),
}));

function makeMockReq(urlPath: string): IncomingMessage {
  return {
    url: urlPath,
    method: "GET",
    headers: { host: "localhost" },
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

const mockEntityMemory = {
  getEpisodesSince: vi.fn().mockResolvedValue([]),
  getAllConcerns: vi.fn().mockResolvedValue([]),
};

const mockStateProvider = {
  entityMemory: mockEntityMemory,
} as unknown as StateProvider;

const baseOpts = {
  auth: { mode: "none" as const },
  stateProvider: mockStateProvider,
};

// ── Tests ──────────────────────────────────────────────────────────────

describe("admin-entity-memory-http /episodes param validation", () => {
  test("returns 400 when days is not a number", async () => {
    const { res, end } = makeMockRes();
    await handleAdminEntityMemoryHttpRequest(
      makeMockReq("/v1/admin/memory/episodes?tenant_id=t1&days=abc"),
      res,
      baseOpts,
    );
    expect(res.statusCode).toBe(400);
    const body = parseResponseBody(end) as { error?: { message?: string } };
    expect(body.error?.message).toContain("days must be a positive integer");
  });

  test("returns 400 when days is a float", async () => {
    const { res, end } = makeMockRes();
    await handleAdminEntityMemoryHttpRequest(
      makeMockReq("/v1/admin/memory/episodes?tenant_id=t1&days=2.5"),
      res,
      baseOpts,
    );
    expect(res.statusCode).toBe(400);
    const body = parseResponseBody(end) as { error?: { message?: string } };
    expect(body.error?.message).toContain("days must be a positive integer");
  });

  test("returns 400 when days is zero", async () => {
    const { res } = makeMockRes();
    await handleAdminEntityMemoryHttpRequest(
      makeMockReq("/v1/admin/memory/episodes?tenant_id=t1&days=0"),
      res,
      baseOpts,
    );
    expect(res.statusCode).toBe(400);
  });

  test("returns 400 when limit is not a number", async () => {
    const { res, end } = makeMockRes();
    await handleAdminEntityMemoryHttpRequest(
      makeMockReq("/v1/admin/memory/episodes?tenant_id=t1&limit=abc"),
      res,
      baseOpts,
    );
    expect(res.statusCode).toBe(400);
    const body = parseResponseBody(end) as { error?: { message?: string } };
    expect(body.error?.message).toContain("limit must be a positive integer");
  });

  test("returns 400 when limit exceeds 500", async () => {
    const { res, end } = makeMockRes();
    await handleAdminEntityMemoryHttpRequest(
      makeMockReq("/v1/admin/memory/episodes?tenant_id=t1&limit=501"),
      res,
      baseOpts,
    );
    expect(res.statusCode).toBe(400);
    const body = parseResponseBody(end) as { error?: { message?: string } };
    expect(body.error?.message).toContain("limit must be a positive integer (max 500)");
  });

  test("returns 400 when limit is zero", async () => {
    const { res } = makeMockRes();
    await handleAdminEntityMemoryHttpRequest(
      makeMockReq("/v1/admin/memory/episodes?tenant_id=t1&limit=0"),
      res,
      baseOpts,
    );
    expect(res.statusCode).toBe(400);
  });

  test("returns 400 when limit is a float", async () => {
    const { res } = makeMockRes();
    await handleAdminEntityMemoryHttpRequest(
      makeMockReq("/v1/admin/memory/episodes?tenant_id=t1&limit=10.5"),
      res,
      baseOpts,
    );
    expect(res.statusCode).toBe(400);
  });

  test("accepts valid days and limit", async () => {
    const { res } = makeMockRes();
    await handleAdminEntityMemoryHttpRequest(
      makeMockReq("/v1/admin/memory/episodes?tenant_id=t1&days=7&limit=50"),
      res,
      baseOpts,
    );
    expect(res.statusCode).toBe(200);
  });

  test("uses defaults when days and limit are omitted", async () => {
    const { res } = makeMockRes();
    mockEntityMemory.getEpisodesSince.mockClear();
    await handleAdminEntityMemoryHttpRequest(
      makeMockReq("/v1/admin/memory/episodes?tenant_id=t1"),
      res,
      baseOpts,
    );
    expect(res.statusCode).toBe(200);
    expect(mockEntityMemory.getEpisodesSince).toHaveBeenCalledWith("t1", expect.any(Date), {
      limit: 100,
    });
  });
});
