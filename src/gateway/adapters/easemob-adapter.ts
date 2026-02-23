/**
 * Easemob IM Channel Adapter
 *
 * Parses Easemob callback payloads into standardized InboundMessage format.
 * Auto-registers on import.
 *
 * Expected inbound body:
 * ```json
 * { "from": "user123", "group_id": "group456", "msg_type": "txt",
 *   "body": { "msg": "hello" } }
 * ```
 */

import {
  registerChannelAdapter,
  type ChannelAdapter,
  type InboundMessage,
} from "../channel-adapter.js";

export class EasemobChannelAdapter implements ChannelAdapter {
  readonly channelName = "easemob";

  parseInbound(body: Record<string, unknown>): InboundMessage | null {
    // Extract message text from Easemob's nested body.msg structure
    const msgBody =
      typeof body.body === "object" && body.body !== null
        ? (body.body as Record<string, unknown>)
        : null;
    const message = msgBody
      ? typeof msgBody.msg === "string"
        ? msgBody.msg.trim()
        : ""
      : typeof body.message === "string"
        ? body.message.trim()
        : "";

    if (!message) {
      return null;
    }

    const sender = typeof body.from === "string" ? body.from.trim() : "unknown";
    const senderName = typeof body.from_name === "string" ? body.from_name.trim() : undefined;
    const groupId = typeof body.group_id === "string" ? body.group_id.trim() : "";

    const peer: InboundMessage["peer"] = groupId
      ? { kind: "group", id: groupId }
      : { kind: "direct", id: sender };

    const metadata: Record<string, unknown> = {};
    if (typeof body.msg_type === "string") {
      metadata.msgType = body.msg_type;
    }
    if (typeof body.msg_id === "string") {
      metadata.msgId = body.msg_id;
    }
    if (typeof body.timestamp === "number" || typeof body.timestamp === "string") {
      metadata.timestamp = body.timestamp;
    }

    return {
      sender,
      senderName: senderName || undefined,
      message,
      peer,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  }
}

// Auto-register on import
registerChannelAdapter(new EasemobChannelAdapter());
