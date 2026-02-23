import type { OpenClawConfig } from "../config/config.js";
import {
  createDatabaseStateProvider,
  createDbPool,
  createFileStateProvider,
  type StateProvider,
} from "../state/index.js";

export function createStateProviderFromConfig(cfg: OpenClawConfig): StateProvider {
  const backend = cfg.gateway?.stateBackend ?? "file";
  if (backend === "database") {
    const dbCfg = cfg.gateway?.database;
    if (!dbCfg) {
      throw new Error("gateway.stateBackend is 'database' but gateway.database config is missing");
    }
    return createDatabaseStateProvider(createDbPool(dbCfg));
  }
  return createFileStateProvider();
}
