// Hermeneia — MCP tool definitions
//
// 14 tools matching the upstream whatsapp-mcp API, plus check_status,
// list_accounts, add_account, and remove_account.
// All tools read from SQLite (store.ts) and send via bridge-manager.ts.

import { readFileSync } from "fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { BridgeManager } from "./bridge-manager.js";
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
  getStoreDiagnostics,
  getMessageMediaInfo,
} from "./store.js";

// Optional account parameter added to all tool schemas
const accountProp = {
  account: {
    type: "string",
    description:
      "Account ID to scope this operation to. Omit to search all accounts. Use list_accounts to see available accounts.",
  },
};

export function registerTools(server: Server, manager: BridgeManager): void {
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request) => {
      const { name, arguments: args } = request.params;
      const accountId = args?.account as string | undefined;

      switch (name) {
        // ── Account management ───────────────────────────────────────

        case "list_accounts": {
          return json(manager.getAllAccountInfo());
        }

        case "add_account": {
          const id = (args?.account_name as string)?.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
          if (!id) return text("Missing required argument: account_name");
          try {
            const result = await manager.addAccount(id);
            return json({
              message: `Account "${id}" created. Scan the QR code to connect.`,
              setup_url: result.setupUrl,
              instructions:
                "Open the setup URL in your browser, then scan the QR code with WhatsApp on your phone (Settings > Linked Devices > Link a Device).",
            });
          } catch (err: any) {
            return text(err.message);
          }
        }

        case "remove_account": {
          const id = args?.account_id as string;
          if (!id) return text("Missing required argument: account_id");
          const removed = await manager.removeAccount(id);
          return removed
            ? json({ message: `Account "${id}" removed. Data preserved on disk.` })
            : text(`Account "${id}" not found`);
        }

        // ── Status ───────────────────────────────────────────────────

        case "check_status": {
          const accounts = manager.getAllAccountInfo();
          const connected = accounts.filter((a) => a.connected);

          if (connected.length > 0) {
            const diagnostics = accountId
              ? [getStoreDiagnostics(accountId)]
              : accounts.map((a) => getStoreDiagnostics(a.id));
            return json({
              status: "connected",
              message: `${connected.length} account(s) connected.`,
              accounts,
              store: diagnostics,
            });
          }

          // Check if any account has a QR pending
          const pending = accounts.find((a) => !a.connected);
          if (pending) {
            return text(
              `No WhatsApp accounts are connected.\n\n` +
                `Use the add_account tool to connect a new account, or check if an existing account needs re-authentication.`
            );
          }

          return text(
            "No WhatsApp accounts configured. Use add_account to connect one."
          );
        }

        // ── Contact tools ────────────────────────────────────────────

        case "search_contacts": {
          const query = args?.query as string;
          if (!query) return text("Missing required argument: query");
          return json(searchContacts(query, accountId));
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
          const chat = getChat(jid, false, accountId);
          let displayName: string | null = null;
          let resolved = false;

          if (chat?.name) {
            displayName = chat.name;
            resolved = displayName !== jid && displayName !== jidUser;
          } else {
            displayName = getSenderName(jid, accountId);
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

        // ── Message tools ────────────────────────────────────────────

        case "list_messages": {
          return json(
            listMessages({
              accountId,
              after: args?.after as string | undefined,
              before: args?.before as string | undefined,
              senderPhoneNumber: args?.sender_phone_number as string | undefined,
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
            (args?.after as number) ?? 5,
            accountId
          );
          return result ? json(result) : text(`Message ${messageId} not found`);
        }

        case "send_message": {
          const recipient = args?.recipient as string;
          const message = args?.message as string;
          if (!recipient) return text("Missing required argument: recipient");
          if (!message) return text("Missing required argument: message");

          const bridge = manager.resolveForSend(accountId);
          if ("error" in bridge) return text(bridge.error);

          const result = await bridge.sendMessage(recipient, message);
          return json(result);
        }

        // ── Chat tools ───────────────────────────────────────────────

        case "list_chats": {
          return json(
            listChats({
              accountId,
              query: args?.query as string | undefined,
              limit: args?.limit as number | undefined,
              page: args?.page as number | undefined,
              includeLastMessage: args?.include_last_message as boolean | undefined,
              sortBy: args?.sort_by as "last_active" | "name" | undefined,
            })
          );
        }

        case "get_chat": {
          const chatJid = args?.chat_jid as string;
          if (!chatJid) return text("Missing required argument: chat_jid");
          const chat = getChat(
            chatJid,
            (args?.include_last_message as boolean) ?? true,
            accountId
          );
          return chat ? json(chat) : text(`Chat ${chatJid} not found`);
        }

        case "get_direct_chat_by_contact": {
          const phone = args?.sender_phone_number as string;
          if (!phone)
            return text("Missing required argument: sender_phone_number");
          const chat = getDirectChatByContact(phone, accountId);
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
              (args?.page as number) ?? 0,
              accountId
            )
          );
        }

        case "get_last_interaction": {
          const jid = args?.jid as string;
          if (!jid) return text("Missing required argument: jid");
          const msg = getLastInteraction(jid, accountId);
          return msg ? json(msg) : text(`No messages found for ${jid}`);
        }

        // ── Media tools ──────────────────────────────────────────────

        case "send_file": {
          const recipient = args?.recipient as string;
          const mediaPath = args?.media_path as string;
          if (!recipient) return text("Missing required argument: recipient");
          if (!mediaPath) return text("Missing required argument: media_path");

          const bridge = manager.resolveForSend(accountId);
          if ("error" in bridge) return text(bridge.error);

          const result = await bridge.sendFile(recipient, mediaPath);
          return json(result);
        }

        case "send_audio_message": {
          const recipient = args?.recipient as string;
          const mediaPath = args?.media_path as string;
          if (!recipient) return text("Missing required argument: recipient");
          if (!mediaPath) return text("Missing required argument: media_path");

          const bridge = manager.resolveForSend(accountId);
          if ("error" in bridge) return text(bridge.error);

          const result = await bridge.sendFile(recipient, mediaPath);
          return json(result);
        }

        case "download_media": {
          const messageId = args?.message_id as string;
          const chatJid = args?.chat_jid as string;
          if (!messageId) return text("Missing required argument: message_id");
          if (!chatJid) return text("Missing required argument: chat_jid");

          const bridge = manager.resolveForSend(accountId);
          if ("error" in bridge) return text(bridge.error);

          // Look up persisted media info from DB
          const mediaInfoJson = getMessageMediaInfo(messageId, accountId);
          const mediaInfo = mediaInfoJson ? JSON.parse(mediaInfoJson) : undefined;

          const result = await bridge.downloadMedia(messageId, chatJid, mediaInfo);
          if (!result.success) return text(result.message);

          const filePath = result.message;
          const mime = mediaInfo?.mimetype ?? guessMime(filePath);

          // For images, return inline so Claude can see them
          if (mime.startsWith("image/")) {
            try {
              const data = readFileSync(filePath);
              const b64 = data.toString("base64");
              return {
                content: [
                  { type: "image" as const, data: b64, mimeType: mime },
                  { type: "text", text: `Downloaded to: ${filePath}` },
                ],
              };
            } catch {
              // Fall through to path-only response if read fails
            }
          }

          return json({
            message: "Media downloaded successfully",
            file_path: filePath,
            mime_type: mime,
          });
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
        // Account management tools
        {
          name: "list_accounts",
          description:
            "List all connected WhatsApp accounts with their status, phone numbers, and names.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        {
          name: "add_account",
          description:
            "Connect a new WhatsApp account. Opens a QR code page in the browser for scanning.",
          inputSchema: {
            type: "object",
            properties: {
              account_name: {
                type: "string",
                description:
                  'A short name for this account (e.g. "work", "personal", "mom")',
              },
            },
            required: ["account_name"],
          },
          annotations: { readOnlyHint: false, openWorldHint: true },
        },
        {
          name: "remove_account",
          description:
            "Disconnect and remove a WhatsApp account. Data is preserved on disk.",
          inputSchema: {
            type: "object",
            properties: {
              account_id: {
                type: "string",
                description: "The account ID to remove (from list_accounts)",
              },
            },
            required: ["account_id"],
          },
          annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        },
        // Status
        {
          name: "check_status",
          description:
            "Check WhatsApp connection status for all accounts.",
          inputSchema: {
            type: "object",
            properties: { ...accountProp },
          },
          annotations: { readOnlyHint: true, openWorldHint: false },
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
              ...accountProp,
            },
            required: ["query"],
          },
          annotations: { readOnlyHint: true, openWorldHint: false },
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
              ...accountProp,
            },
            required: ["identifier"],
          },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        {
          name: "list_messages",
          description:
            "Get WhatsApp messages with filters, date ranges, and sorting. Searches all accounts by default.",
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
              ...accountProp,
            },
          },
          annotations: { readOnlyHint: true, openWorldHint: false },
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
              ...accountProp,
            },
            required: ["message_id"],
          },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        {
          name: "send_message",
          description:
            "Send a WhatsApp text message to a contact or group. Must specify account if multiple are connected.",
          inputSchema: {
            type: "object",
            properties: {
              recipient: {
                type: "string",
                description:
                  "Phone number (no + or symbols) or JID (e.g. 12025551234 or 123@g.us)",
              },
              message: { type: "string", description: "Message text" },
              ...accountProp,
            },
            required: ["recipient", "message"],
          },
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        },
        {
          name: "list_chats",
          description: "List WhatsApp chats with metadata. Searches all accounts by default.",
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
              ...accountProp,
            },
          },
          annotations: { readOnlyHint: true, openWorldHint: false },
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
              ...accountProp,
            },
            required: ["chat_jid"],
          },
          annotations: { readOnlyHint: true, openWorldHint: false },
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
              ...accountProp,
            },
            required: ["sender_phone_number"],
          },
          annotations: { readOnlyHint: true, openWorldHint: false },
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
              ...accountProp,
            },
            required: ["jid"],
          },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        {
          name: "get_last_interaction",
          description: "Get the most recent message with a contact.",
          inputSchema: {
            type: "object",
            properties: {
              jid: { type: "string", description: "Contact JID" },
              ...accountProp,
            },
            required: ["jid"],
          },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        {
          name: "send_file",
          description:
            "Send an image, video, or document via WhatsApp. Must specify account if multiple are connected.",
          inputSchema: {
            type: "object",
            properties: {
              recipient: { type: "string", description: "Phone or JID" },
              media_path: {
                type: "string",
                description: "Absolute path to the file",
              },
              ...accountProp,
            },
            required: ["recipient", "media_path"],
          },
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        },
        {
          name: "send_audio_message",
          description:
            "Send a voice message via WhatsApp. Must specify account if multiple are connected.",
          inputSchema: {
            type: "object",
            properties: {
              recipient: { type: "string", description: "Phone or JID" },
              media_path: {
                type: "string",
                description: "Absolute path to the audio file",
              },
              ...accountProp,
            },
            required: ["recipient", "media_path"],
          },
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        },
        {
          name: "download_media",
          description: "Download media from a received WhatsApp message.",
          inputSchema: {
            type: "object",
            properties: {
              message_id: { type: "string", description: "Message ID" },
              chat_jid: { type: "string", description: "Chat JID" },
              ...accountProp,
            },
            required: ["message_id", "chat_jid"],
          },
          annotations: { readOnlyHint: true, openWorldHint: false },
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

function guessMime(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp",
    mp4: "video/mp4", mov: "video/quicktime",
    ogg: "audio/ogg", mp3: "audio/mpeg",
    pdf: "application/pdf",
  };
  return map[ext ?? ""] ?? "application/octet-stream";
}
