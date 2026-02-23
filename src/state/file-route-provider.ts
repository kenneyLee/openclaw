import type { ResolveAgentRouteInput, ResolvedAgentRoute } from "../routing/resolve-route.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import type { RouteProvider } from "./types.js";

export class FileRouteProvider implements RouteProvider {
  resolveAgentRoute(input: ResolveAgentRouteInput): ResolvedAgentRoute {
    return resolveAgentRoute(input);
  }
}
