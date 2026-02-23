import { loadExtraBootstrapFiles, loadWorkspaceBootstrapFiles } from "../agents/workspace.js";
import { FileRouteProvider } from "./file-route-provider.js";
import { FileSessionStoreProvider } from "./file-session-store-provider.js";
import type {
  BootstrapFileProvider,
  BootstrapLoadContext,
  RouteProvider,
  SessionStoreProvider,
  StateProvider,
} from "./types.js";

class FileBootstrapProvider implements BootstrapFileProvider {
  async loadBootstrapFiles(ctx: BootstrapLoadContext) {
    if (!ctx.workspaceDir) {
      throw new Error("FileBootstrapProvider requires workspaceDir");
    }
    return loadWorkspaceBootstrapFiles(ctx.workspaceDir);
  }

  async loadExtraBootstrapFiles(ctx: BootstrapLoadContext, extraPatterns: string[]) {
    if (!ctx.workspaceDir) {
      throw new Error("FileBootstrapProvider requires workspaceDir");
    }
    return loadExtraBootstrapFiles(ctx.workspaceDir, extraPatterns);
  }
}

export class FileStateProvider implements StateProvider {
  readonly id = "file";
  readonly bootstrap: BootstrapFileProvider;
  readonly routing: RouteProvider;
  readonly sessions: SessionStoreProvider;

  constructor() {
    this.bootstrap = new FileBootstrapProvider();
    this.routing = new FileRouteProvider();
    this.sessions = new FileSessionStoreProvider();
  }
}

export function createFileStateProvider(): FileStateProvider {
  return new FileStateProvider();
}
