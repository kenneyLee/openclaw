import type { Pool } from "mysql2/promise";
import { DatabaseBootstrapProvider } from "./db-bootstrap-provider.js";
import { DatabaseRouteProvider } from "./db-route-provider.js";
import { DatabaseSessionStoreProvider } from "./db-session-store-provider.js";
import type {
  BootstrapFileProvider,
  RouteProvider,
  SessionStoreProvider,
  StateProvider,
} from "./types.js";

export type DatabaseStateProviderOptions = {
  routeMatchKey?: string;
};

export class DatabaseStateProvider implements StateProvider {
  readonly id = "database";
  readonly bootstrap: BootstrapFileProvider;
  readonly routing: RouteProvider;
  readonly sessions: SessionStoreProvider;

  constructor(pool: Pool, opts?: DatabaseStateProviderOptions) {
    this.bootstrap = new DatabaseBootstrapProvider(pool);
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
