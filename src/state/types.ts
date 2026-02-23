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
}
