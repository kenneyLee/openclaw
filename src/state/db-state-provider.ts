import type { Pool } from "mysql2/promise";
import { DatabaseApiKeyProvider } from "./db-api-key-provider.js";
import { DatabaseBootstrapProvider } from "./db-bootstrap-provider.js";
import { DatabaseRouteProvider } from "./db-route-provider.js";
import { DatabaseSessionStoreProvider } from "./db-session-store-provider.js";
import { DatabaseWebhookProvider } from "./db-webhook-provider.js";
import type {
  ApiKeyProvider,
  BootstrapFileProvider,
  RouteProvider,
  SessionStoreProvider,
  StateProvider,
  WebhookProvider,
} from "./types.js";

export type DatabaseStateProviderOptions = {
  routeMatchKey?: string;
};

export class DatabaseStateProvider implements StateProvider {
  readonly id = "database";
  readonly bootstrap: BootstrapFileProvider;
  readonly routing: RouteProvider;
  readonly sessions: SessionStoreProvider;
  readonly apiKeys: ApiKeyProvider;
  readonly webhooks: WebhookProvider;

  constructor(pool: Pool, opts?: DatabaseStateProviderOptions) {
    this.bootstrap = new DatabaseBootstrapProvider(pool);
    this.routing = new DatabaseRouteProvider(pool, { matchKey: opts?.routeMatchKey });
    this.sessions = new DatabaseSessionStoreProvider(pool);
    this.apiKeys = new DatabaseApiKeyProvider(pool);
    this.webhooks = new DatabaseWebhookProvider(pool);
  }
}

export function createDatabaseStateProvider(
  pool: Pool,
  opts?: DatabaseStateProviderOptions,
): DatabaseStateProvider {
  return new DatabaseStateProvider(pool, opts);
}
