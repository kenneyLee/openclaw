import type { WebSocket } from "ws";
import type { ConnectParams } from "../protocol/index.js";

export type GatewayWsClient = {
  socket: WebSocket;
  connect: ConnectParams;
  connId: string;
  presenceKey?: string;
  clientIp?: string;
  canvasCapability?: string;
  canvasCapabilityExpiresAtMs?: number;
  /** Tenant ID resolved from osk_ API key during WS handshake. */
  tenantId?: string;
};
