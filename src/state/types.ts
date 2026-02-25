import type { WorkspaceBootstrapFile } from "../agents/workspace.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { ResolveAgentRouteInput, ResolvedAgentRoute } from "../routing/resolve-route.js";

/**
 * Context for loading bootstrap files.
 * FileStateProvider uses workspaceDir; DatabaseStateProvider uses tenantId.
 */
export type BootstrapLoadContext = {
  workspaceDir?: string;
  tenantId?: string;
  agentId?: string;
};

export interface BootstrapFileProvider {
  loadBootstrapFiles(ctx: BootstrapLoadContext): Promise<WorkspaceBootstrapFile[]>;
  loadExtraBootstrapFiles(
    ctx: BootstrapLoadContext,
    extraPatterns: string[],
  ): Promise<WorkspaceBootstrapFile[]>;
}

export interface SessionStoreProvider {
  loadSessionStore(
    storePath: string,
    opts?: { skipCache?: boolean },
  ): Record<string, SessionEntry> | Promise<Record<string, SessionEntry>>;
  saveSessionStore(storePath: string, store: Record<string, SessionEntry>): Promise<void>;
  updateSessionStore<T>(
    storePath: string,
    mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
  ): Promise<T>;
}

export interface RouteProvider {
  resolveAgentRoute(
    input: ResolveAgentRouteInput,
  ): ResolvedAgentRoute | Promise<ResolvedAgentRoute>;
}

export interface ApiKeyProvider {
  resolveApiKey(rawKey: string): Promise<{ tenantId: string; scopes: string[] | null } | null>;
}

export type WebhookConfig = {
  webhookId: string;
  tenantId: string;
  callbackUrl: string;
  signingSecret: string;
  agentId: string;
};

export interface WebhookProvider {
  resolveWebhook(tenantId: string): Promise<WebhookConfig | null>;
}

export interface TenantProvider {
  create(params: {
    tenantId: string;
    name?: string;
    templateId?: string;
    templateData?: Record<string, unknown>;
  }): Promise<{
    tenantId: string;
    name: string;
    templateId: string | null;
    templateData: Record<string, unknown> | null;
    status: string;
    createdAt: string;
    updatedAt: string;
  }>;
  get(tenantId: string): Promise<{
    tenantId: string;
    name: string;
    templateId: string | null;
    templateData: Record<string, unknown> | null;
    status: string;
    createdAt: string;
    updatedAt: string;
  } | null>;
  list(): Promise<
    Array<{
      tenantId: string;
      name: string;
      templateId: string | null;
      templateData: Record<string, unknown> | null;
      status: string;
      createdAt: string;
      updatedAt: string;
    }>
  >;
  update(
    tenantId: string,
    params: {
      name?: string;
      templateId?: string | null;
      templateData?: Record<string, unknown> | null;
      status?: "active" | "suspended";
    },
  ): Promise<{ updated: number }>;
}

// ── Entity Memory Types ──

export interface MemoryProfile {
  tenantId: string;
  profileData: Record<string, unknown>;
  version: number;
  lastInteractionAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEpisode {
  id: number;
  tenantId: string;
  episodeType: string;
  channel: string;
  content: string;
  metadata: Record<string, unknown> | null;
  isSuperseded: boolean;
  createdAt: string;
}

export interface MemoryConcern {
  id: number;
  tenantId: string;
  concernKey: string;
  displayName: string;
  severity: "low" | "medium" | "high" | "critical";
  status: "active" | "improving" | "resolved" | "escalated";
  mentionCount: number;
  evidence: Array<{ text: string; source: string; date: string }>;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  followupDue: string | null;
}

export interface EntityMemoryProvider {
  getProfile(tenantId: string): Promise<MemoryProfile | null>;
  upsertProfile(
    tenantId: string,
    updates: Record<string, unknown>,
    expectedVersion: number,
  ): Promise<{ updated: boolean; newVersion: number }>;

  insertEpisode(
    tenantId: string,
    episode: {
      episodeType: string;
      channel: string;
      content: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ id: number }>;
  getRecentEpisodes(
    tenantId: string,
    opts?: { limit?: number; episodeType?: string },
  ): Promise<MemoryEpisode[]>;
  getEpisodesSince(
    tenantId: string,
    since: Date,
    opts?: { limit?: number },
  ): Promise<MemoryEpisode[]>;

  upsertConcern(
    tenantId: string,
    concern: {
      concernKey: string;
      displayName: string;
      severity: "low" | "medium" | "high" | "critical";
      evidenceText: string;
      source: string;
    },
  ): Promise<{ id: number; mentionCount: number }>;
  getActiveConcerns(tenantId: string): Promise<MemoryConcern[]>;
  getAllConcerns(tenantId: string): Promise<MemoryConcern[]>;
  updateConcernStatus(
    tenantId: string,
    concernKey: string,
    status: "improving" | "resolved" | "escalated",
  ): Promise<{ updated: number }>;

  renderMemoryFile(tenantId: string): Promise<{ rendered: boolean }>;

  /** Transactional batch write: profile + episode + concerns + render in a single transaction. */
  ingest(
    tenantId: string,
    opts: {
      profileUpdates?: Record<string, unknown>;
      episode?: {
        episodeType: string;
        channel: string;
        content: string;
        metadata?: Record<string, unknown>;
      };
      concerns?: Array<{
        concernKey: string;
        displayName: string;
        severity: "low" | "medium" | "high" | "critical";
        evidenceText: string;
        source: string;
      }>;
      render?: boolean;
    },
  ): Promise<{
    profile?: { updated: boolean; newVersion: number };
    episode?: { id: number };
    concerns?: Array<{ id: number; mentionCount: number }>;
    render?: { rendered: boolean };
  }>;
}

/**
 * Composite StateProvider — all sub-providers are optional,
 * allowing incremental adoption. Missing = use existing code path.
 */
export interface StateProvider {
  readonly id: string;
  readonly bootstrap?: BootstrapFileProvider;
  readonly sessions?: SessionStoreProvider;
  readonly routing?: RouteProvider;
  readonly apiKeys?: ApiKeyProvider;
  readonly webhooks?: WebhookProvider;
  readonly tenants?: TenantProvider;
  readonly entityMemory?: EntityMemoryProvider;
}
