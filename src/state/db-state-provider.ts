import type { Pool } from "mysql2/promise";
import { DatabaseRouteProvider } from "./db-route-provider.js";
import { DatabaseSessionStoreProvider } from "./db-session-store-provider.js";
import type { RouteProvider, SessionStoreProvider, StateProvider } from "./types.js";

export type DatabaseStateProviderOptions = {
  routeMatchKey?: string;
};

export class DatabaseStateProvider implements StateProvider {
  readonly id = "database";
  readonly routing: RouteProvider;
  readonly sessions: SessionStoreProvider;
  // bootstrap 暂未实现，留 undefined（StateProvider 接口中是 optional）

  constructor(pool: Pool, opts?: DatabaseStateProviderOptions) {
    this.routing = new DatabaseRouteProvider(pool, { matchKey: opts?.routeMatchKey });
    this.sessions = new DatabaseSessionStoreProvider(pool);
  }
}

export function createDatabaseStateProvider(
  pool: Pool,
  opts?: DatabaseStateProviderOptions,
): DatabaseStateProvider {
  return new DatabaseStateProvider(pool, opts);
}
