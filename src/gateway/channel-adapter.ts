/**
 * Channel Adapter — lightweight abstraction for normalizing inbound messages
 * from external IM systems (Easemob, etc.) into a standard format, and
 * optionally formatting outbound results.
 */

/** Standardized inbound message from any channel. */
export type InboundMessage = {
  sender: string;
  senderName?: string;
  message: string;
  peer: { kind: "group" | "direct"; id: string };
  metadata?: Record<string, unknown>;
};

/** Channel adapter interface. */
export interface ChannelAdapter {
  readonly channelName: string;

  /** Parse raw inbound body into a standardized InboundMessage, or null if unparseable. */
  parseInbound(body: Record<string, unknown>): InboundMessage | null;

  /** Optionally format an agent result for delivery back through the channel. */
  formatOutbound?(
    result: { text: string; runId: string; tenantId: string },
    inbound: InboundMessage,
  ): Record<string, unknown>;
}

// ── Registry ─────────────────────────────────────────────────────────

const adapters = new Map<string, ChannelAdapter>();

export function registerChannelAdapter(adapter: ChannelAdapter): void {
  adapters.set(adapter.channelName.toLowerCase(), adapter);
}

export function getChannelAdapter(channelName: string): ChannelAdapter | undefined {
  return adapters.get(channelName.toLowerCase());
}

// ── Generic fallback adapter ─────────────────────────────────────────

/**
 * Generic adapter that accepts a simple `{ message, sender, group_id? }` body.
 * Used as fallback when no channel-specific adapter is registered.
 */
export class GenericChannelAdapter implements ChannelAdapter {
  readonly channelName = "generic";

  parseInbound(body: Record<string, unknown>): InboundMessage | null {
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      return null;
    }
    const sender = typeof body.sender === "string" ? body.sender.trim() : "unknown";
    const groupId = typeof body.group_id === "string" ? body.group_id.trim() : "";
    return {
      sender,
      message,
      peer: groupId ? { kind: "group", id: groupId } : { kind: "direct", id: sender },
    };
  }
}

export const genericAdapter = new GenericChannelAdapter();
