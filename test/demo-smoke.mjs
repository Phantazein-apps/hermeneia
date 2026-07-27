#!/usr/bin/env node
// Demo-mode smoke test — boots the built MCP server with HERMENEIA_DEMO=1,
// drives it over stdio with a real MCP client, and calls every tool once.
// No Go binary, no network, no WhatsApp account needed: this is the
// cross-platform CI check for the TS/store layer (see ci.yml).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(__dirname, "..", "dist", "index.js");

let failures = 0;
function assertTrue(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  } else {
    console.log(`ok — ${msg}`);
  }
}

function textOf(result) {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "hermeneia-demo-"));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      ...process.env,
      HERMENEIA_DEMO: "1",
      HERMENEIA_DATA_DIR: dataDir,
      HERMENEIA_QR_PORT: "0", // any free port — demo mode never opens it anyway
    },
  });

  const client = new Client({ name: "hermeneia-demo-smoke", version: "0.0.0" }, { capabilities: {} });

  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    assertTrue(tools.length === 18, `expected 18 tools, got ${tools.length}`);

    const call = (name, args = {}) => client.callTool({ name, arguments: args });

    // check_status — demo mode banner
    const status = await call("check_status");
    assertTrue(!status.isError, "check_status did not error");
    assertTrue(textOf(status).includes("DEMO MODE"), "check_status mentions DEMO MODE");

    // list_accounts
    const accounts = await call("list_accounts");
    assertTrue(!accounts.isError, "list_accounts did not error");

    // list_chats — expect our fixture chats, including the archived one excluded by default
    const chats = await call("list_chats", { limit: 50 });
    const chatsJson = JSON.parse(textOf(chats));
    assertTrue(Array.isArray(chatsJson) && chatsJson.length >= 6, `list_chats returned ${chatsJson?.length} chats (expected >= 6)`);

    // search_contacts
    const contacts = await call("search_contacts", { query: "Tyler" });
    assertTrue(!contacts.isError, "search_contacts did not error");
    assertTrue(textOf(contacts).includes("Tyler"), "search_contacts finds Tyler");

    // list_messages — the Airbnb link must actually be findable (README example)
    const airbnb = await call("list_messages", { query: "Airbnb", limit: 10 });
    assertTrue(!airbnb.isError, "list_messages(Airbnb) did not error");
    assertTrue(textOf(airbnb).includes("airbnb.com"), "search finds the Airbnb link fixture");

    // unread count sanity — check_status/store diagnostics or list_chats unread_count sum > 0
    const totalUnread = chatsJson.reduce((sum, c) => sum + (c.unread_count ?? 0), 0);
    assertTrue(totalUnread > 0, `total unread across fixture chats is ${totalUnread} (expected > 0)`);

    // find the photo message via list_messages on Tyler's chat, then download_media
    const tylerChat = chatsJson.find((c) => c.name === "Tyler Chen");
    assertTrue(!!tylerChat, "Tyler Chen fixture chat exists");
    if (tylerChat) {
      const tylerMsgs = await call("list_messages", { chat_jid: tylerChat.jid, limit: 50, sort_by: "oldest" });
      const tylerMsgsJson = JSON.parse(textOf(tylerMsgs));
      const photoMsg = tylerMsgsJson.find((m) => m.media_type === "image");
      assertTrue(!!photoMsg, "Tyler chat has an image fixture message");
      if (photoMsg) {
        const media = await call("download_media", { message_id: photoMsg.id, chat_jid: tylerChat.jid });
        const hasImage = (media.content ?? []).some((c) => c.type === "image" && c.data?.length > 0);
        assertTrue(hasImage, "download_media returns real image bytes for the bundled photo");
        const imgBlock = (media.content ?? []).find((c) => c.type === "image");
        assertTrue((imgBlock?.data?.length ?? 0) > 1000, "downloaded image has a non-trivial byte length");
      }

      // send_message → demo mode always succeeds, and a canned reply lands
      // in the store a couple seconds later.
      const sendResult = await call("send_message", { recipient: tylerChat.jid, message: "smoke test ping" });
      assertTrue(!sendResult.isError, "send_message did not error in demo mode");
      await new Promise((r) => setTimeout(r, 3500));
      const afterSend = await call("list_messages", { chat_jid: tylerChat.jid, limit: 5, sort_by: "newest" });
      assertTrue(textOf(afterSend).includes("demo mode"), "canned reply lands in the store after send_message");
    }

    // add_account must be refused with a friendly message in demo mode
    const addAcct = await call("add_account", { account_name: "second" });
    assertTrue(textOf(addAcct).toLowerCase().includes("demo mode"), "add_account refuses with a demo-mode explanation");
  } finally {
    await client.close().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll demo-mode smoke checks passed.");
}

main().catch((err) => {
  console.error("Demo smoke test crashed:", err);
  process.exit(1);
});
