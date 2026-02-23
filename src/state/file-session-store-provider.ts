import {
  loadSessionStore,
  saveSessionStore,
  updateSessionStore,
} from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { SessionStoreProvider } from "./types.js";

export class FileSessionStoreProvider implements SessionStoreProvider {
  loadSessionStore(
    storePath: string,
    opts?: { skipCache?: boolean },
  ): Record<string, SessionEntry> {
    return loadSessionStore(storePath, opts);
  }

  saveSessionStore(storePath: string, store: Record<string, SessionEntry>): Promise<void> {
    return saveSessionStore(storePath, store);
  }

  updateSessionStore<T>(
    storePath: string,
    mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
  ): Promise<T> {
    return updateSessionStore(storePath, mutator);
  }
}
