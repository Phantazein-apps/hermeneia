// Hermeneia — MCP tool definitions
//
// 14 tools matching the upstream whatsapp-mcp API, plus check_status.
// All tools read from SQLite (store.ts) and send via bridge.ts.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { WhatsAppBridge } from "./bridge.js";
import {
  searchContacts,
  listMessages,
  listChats,
  getChat,
  getDirectChatByContact,
  getContactChats,
  getLastInteraction,
  getMessageContext,
  getSenderName,
} from "./store.js";

export function registerTools(server: Server, bridge: WhatsAppBridge): void {
  // ── check_status ────────────────────────────────────────────────

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case "check_status": {
          const status = bridge.status;
          if (status.connected && status.authenticated) {
            return text("WhatsApp is connected and ready.");
          }
          if (status.qr_url) {
            return text(
              `WhatsApp is not connected. Please scan the QR code to authenticate:\n\n` +
                `Open this URL in your browser: ${status.qr_url}\n\n` +
                `Then scan the QR code with WhatsApp on your phone:\n` +
                `Settings > Linked Devices > Link a Device`
            );
          }
          return text(
            "WhatsApp is disconnected. The bridge is attempting to reconnect..."
          );
        }

        // ── Contact tools ───────────────────────────────────────────

        case "search_contacts": {
          const query = args?.query as string;
          if (!query) return text("Missing required argument: query");
          return json(searchContacts(query));
        }

        case "get_contact": {
          const identifier =
            (args?.identifier as string) ??
            (args?.phone_number as string) ??
            (args?.phone as string);
          if (!identifier) return text("Missing required argument: identifier");

          const cleaned = identifier.trim();
          if (!cleaned) return text("Identifier must be non-empty");

          let jid: string;
          let isLid = false;

          if (cleaned.includes("@")) {
            jid = cleaned;
            isLid = jid.endsWith("@lid");
          } else {
            const digits = cleaned.replace(/\D/g, "");
            if (digits.length > 15) {
              jid = `${digits}@lid`;
              isLid = true;
            } else {
              jid = `${digits}@s.whatsapp.net`;
            }
          }

          const jidUser = jid.split("@")[0];
          const chat = getChat(jid, false);
          let displayName: string | null = null;
          let resolved = false;

          if (chat?.name) {
            displayName = chat.name;
            resolved = displayName !== jid && displayName !== jidUser;
          } else {
            displayName = getSenderName(jid);
            resolved =
              displayName !== jid &&
              displayName !== jidUser &&
              displayName !== identifier;
          }

          return json({
            identifier,
            jid,
            phone_number: isLid ? null : jidUser,
            lid: isLid ? jidUser : null,
            name: resolved ? displayName : jidUser,
            display_name: displayName,
            is_lid: isLid,
            resolved,
          });
        }

        // ── Message tools ───────────────────────────────────────────

        case "list_messages": {
          return json(
            listMessages({
              after: args?.after as string | undefined,
              before: args?.before as string | undefined,
              senderPhoneNumber: args?.sender_phone_number as
                | string
                | undefined,
              chatJid: args?.chat_jid as string | undefined,
              query: args?.query as string | undefined,
              limit: args?.limit as number | undefined,
              page: args?.page as number | undefined,
              sortBy: args?.sort_by as "newest" | "oldest" | undefined,
            })
          );
        }

        case "get_message_context": {
          const messageId = args?.message_id as string;
          if (!messageId) return text("Missing required argument: message_id");
          const result = getMessageContext(
            messageId,
            (args?.before as number) ?? 5,
            (args?.after as number) ?? 5
          );
          return result ? json(result) : text(`Message ${messageId} not found`);
        }

        case "send_message": {
          const recipient = args?.recipient as string;
          const message = args?.message as string;
          if (!recipient) return text("Missing required argument: recipient");
          if (!message) return text("Missing required argument: message");
          const result = await bridge.sendMessage(recipient, message);
          return json(result);
        }

        // ── Chat tools ──────────────────────────────────────────────

        case "list_chats": {
          return json(
            listChats({
              query: args?.query as string | undefined,
              limit: args?.limit as number | undefined,
              page: args?.page as number | undefined,
              includeLastMessage: args?.include_last_message as
                | boolean
                | undefined,
              sortBy: args?.sort_by as "last_active" | "name" | undefined,
            })
          );
        }

        case "get_chat": {
          const chatJid = args?.chat_jid as string;
          if (!chatJid) return text("Missing required argument: chat_jid");
          const chat = getChat(
            chatJid,
            (args?.include_last_message as boolean) ?? true
          );
          return chat ? json(chat) : text(`Chat ${chatJid} not found`);
        }

        case "get_direct_chat_by_contact": {
          const phone = args?.sender_phone_number as string;
          if (!phone)
            return text("Missing required argument: sender_phone_number");
          const chat = getDirectChatByContact(phone);
          return chat
            ? json(chat)
            : text(`No direct chat found for ${phone}`);
        }

        case "get_contact_chats": {
          const jid = args?.jid as string;
          if (!jid) return text("Missing required argument: jid");
          return json(
            getContactChats(
              jid,
              (args?.limit as number) ?? 20,
              (args?.page as number) ?? 0
            )
          );
        }

        case "get_last_interaction": {
          const jid = args?.jid as string;
          if (!jid) return text("Missing required argument: jid");
          const msg = getLastInteraction(jid);
          return msg ? json(msg) : text(`No messages found for ${jid}`);
        }

        // ── Media tools ─────────────────────────────────────────────

        case "send_file": {
          const recipient = args?.recipient as string;
          const mediaPath = args?.media_path as string;
          if (!recipient) return text("Missing required argument: recipient");
          if (!mediaPath) return text("Missing required argument: media_path");
          const result = await bridge.sendFile(recipient, mediaPath);
          return json(result);
        }

        case "send_audio_message": {
          const recipient = args?.recipient as string;
          const mediaPath = args?.media_path as string;
          if (!recipient) return text("Missing required argument: recipient");
          if (!mediaPath) return text("Missing required argument: media_path");
          // Baileys handles audio conversion internally for ogg/opus
          const result = await bridge.sendFile(recipient, mediaPath);
          return json(result);
        }

        case "download_media": {
          // TODO: implement media download from message store
          return text(
            "Media download requires the original message object. " +
              "This feature is coming in a future version."
          );
        }

        default:
          return text(`Unknown tool: ${name}`);
      }
    }
  );

  // ── Tool listing ──────────────────────────────────────────────────

  server.setRequestHandler(
    ListToolsRequestSchema,
    async () => ({
      tools: [
        {
          name: "check_status",
          description:
            "Check WhatsApp connection status. If not connected, returns instructions to authenticate.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "search_contacts",
          description: "Search WhatsApp contacts by name or phone number.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search term to match against names or phones",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "get_contact",
          description:
            "Look up a WhatsApp contact by phone number, LID, or full JID.",
          inputSchema: {
            type: "object",
            properties: {
              identifier: {
                type: "string",
                description:
                  'Phone number, LID, or JID (e.g. "12025551234", "12025551234@s.whatsapp.net")',
              },
            },
            required: ["identifier"],
          },
        },
        {
          name: "list_messages",
          description:
            "Get WhatsApp messages with filters, date ranges, and sorting.",
          inputSchema: {
            type: "object",
            properties: {
              after: {
                type: "string",
                description: "ISO-8601 date (e.g. 2026-01-01)",
              },
              before: {
                type: "string",
                description: "ISO-8601 date (e.g. 2026-01-09)",
              },
              sender_phone_number: {
                type: "string",
                description: "Filter by sender phone",
              },
              chat_jid: { type: "string", description: "Filter by chat JID" },
              query: { type: "string", description: "Search term" },
              limit: { type: "number", description: "Max results (default 50)" },
              page: {
                type: "number",
                description: "Page number (default 0)",
              },
              sort_by: {
                type: "string",
                enum: ["newest", "oldest"],
                description: "Sort order (default newest)",
              },
            },
          },
        },
        {
          name: "get_message_context",
          description: "Get messages around a specific message by ID.",
          inputSchema: {
            type: "object",
            properties: {
              message_id: { type: "string", description: "The message ID" },
              before: {
                type: "number",
                description: "Messages before (default 5)",
              },
              after: {
                type: "number",
                description: "Messages after (default 5)",
              },
            },
            required: ["message_id"],
          },
        },
        {
          name: "send_message",
          description:
            "Send a WhatsApp text message to a contact or group.",
          inputSchema: {
            type: "object",
            properties: {
              recipient: {
                type: "string",
                description:
                  "Phone number (no + or symbols) or JID (e.g. 12025551234 or 123@g.us)",
              },
              message: { type: "string", description: "Message text" },
            },
            required: ["recipient", "message"],
          },
        },
        {
          name: "list_chats",
          description: "List WhatsApp chats with metadata.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Filter by name or JID" },
              limit: { type: "number", description: "Max results (default 50)" },
              page: { type: "number", description: "Page (default 0)" },
              include_last_message: {
                type: "boolean",
                description: "Include last message (default true)",
              },
              sort_by: {
                type: "string",
                enum: ["last_active", "name"],
                description: "Sort order",
              },
            },
          },
        },
        {
          name: "get_chat",
          description: "Get a specific WhatsApp chat by JID.",
          inputSchema: {
            type: "object",
            properties: {
              chat_jid: { type: "string", description: "Chat JID" },
              include_last_message: {
                type: "boolean",
                description: "Include last message (default true)",
              },
            },
            required: ["chat_jid"],
          },
        },
        {
          name: "get_direct_chat_by_contact",
          description: "Find a direct message chat by phone number.",
          inputSchema: {
            type: "object",
            properties: {
              sender_phone_number: {
                type: "string",
                description: "Phone number",
              },
            },
            required: ["sender_phone_number"],
          },
        },
        {
          name: "get_contact_chats",
          description: "List all chats involving a specific contact.",
          inputSchema: {
            type: "object",
            properties: {
              jid: { type: "string", description: "Contact JID" },
              limit: { type: "number", description: "Max results (default 20)" },
              page: { type: "number", description: "Page (default 0)" },
            },
            required: ["jid"],
          },
        },
        {
          name: "get_last_interaction",
          description: "Get the most recent message with a contact.",
          inputSchema: {
            type: "object",
            properties: {
              jid: { type: "string", description: "Contact JID" },
            },
            required: ["jid"],
          },
        },
        {
          name: "send_file",
          description:
            "Send an image, video, or document via WhatsApp.",
          inputSchema: {
            type: "object",
            properties: {
              recipient: { type: "string", description: "Phone or JID" },
              media_path: {
                type: "string",
                description: "Absolute path to the file",
              },
            },
            required: ["recipient", "media_path"],
          },
        },
        {
          name: "send_audio_message",
          description:
            "Send a voice message via WhatsApp.",
          inputSchema: {
            type: "object",
            properties: {
              recipient: { type: "string", description: "Phone or JID" },
              media_path: {
                type: "string",
                description: "Absolute path to the audio file",
              },
            },
            required: ["recipient", "media_path"],
          },
        },
        {
          name: "download_media",
          description: "Download media from a received WhatsApp message.",
          inputSchema: {
            type: "object",
            properties: {
              message_id: { type: "string", description: "Message ID" },
              chat_jid: { type: "string", description: "Chat JID" },
            },
            required: ["message_id", "chat_jid"],
          },
        },
      ],
    })
  );
}

// ── Helpers ───────────────────────────────────────────────────────

function text(content: string) {
  return { content: [{ type: "text", text: content }] };
}

function json(data: any) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}
