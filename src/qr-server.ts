// Hermeneia — Web-based QR code auth page
//
// Starts a tiny local HTTP server that displays the WhatsApp QR code
// in a browser instead of the terminal. Supports multiple accounts
// via /setup/{accountId} routes.

import { createServer, type Server } from "http";
import { existsSync } from "fs";
import { join } from "path";
import QRCode from "qrcode";
import type { WhatsAppBridge } from "./bridge.js";

const log = (msg: string) => console.error(`[hermeneia:qr] ${msg}`);

let server: Server | null = null;

// Per-account QR session state
interface QRSession {
  qrDataUrl: string | null;
  authenticated: boolean;
  bridge: WhatsAppBridge;
}
const sessions = new Map<string, QRSession>();

function getOrCreateSession(bridge: WhatsAppBridge, accountId: string): QRSession {
  let session = sessions.get(accountId);
  if (!session) {
    session = { qrDataUrl: null, authenticated: false, bridge };
    sessions.set(accountId, session);
  }
  return session;
}

function setupHtml(accountId: string): string {
  const title = accountId === "default" ? "Connect WhatsApp" : `Connect WhatsApp — ${accountId}`;
  return SETUP_HTML.replaceAll("{{TITLE}}", title).replaceAll("{{ACCOUNT_ID}}", accountId);
}

const SETUP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hermeneia — {{TITLE}}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
    }
    .card {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 16px;
      padding: 48px;
      text-align: center;
      max-width: 480px;
      width: 90%;
    }
    h1 {
      font-size: 28px;
      font-weight: 600;
      margin-bottom: 8px;
      background: linear-gradient(135deg, #25D366, #128C7E);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .subtitle {
      color: #888;
      margin-bottom: 32px;
      font-size: 14px;
    }
    #qr-container {
      margin: 24px auto;
      padding: 16px;
      background: white;
      border-radius: 12px;
      display: inline-block;
      min-width: 256px;
      min-height: 256px;
      position: relative;
    }
    #qr-container img { display: block; width: 256px; height: 256px; }
    #qr-container img[src=""] { display: none; }
    .spinner-wrap {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
    }
    .spinner {
      width: 40px; height: 40px;
      border: 3px solid #eee;
      border-top-color: #25D366;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner-label { color: #aaa; font-size: 13px; }
    .steps {
      text-align: left;
      margin-top: 24px;
      padding: 0 8px;
    }
    .steps li {
      margin-bottom: 12px;
      color: #ccc;
      font-size: 15px;
      line-height: 1.5;
    }
    .steps li strong { color: #25D366; }
    .success {
      color: #25D366;
      font-size: 48px;
      margin: 24px 0;
    }
    #status { color: #888; font-size: 13px; margin-top: 16px; }
    .waiting { display: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Hermeneia</h1>
    <p class="subtitle">{{TITLE}}</p>

    <div id="qr-view">
      <div id="qr-container">
        <div class="spinner-wrap" id="spinner">
          <div class="spinner"></div>
          <span class="spinner-label">Connecting… this takes ~15 seconds</span>
        </div>
        <img id="qr-img" src="" alt="QR Code" />
      </div>
      <ol class="steps">
        <li>Open <strong>WhatsApp</strong> on your phone</li>
        <li>Go to <strong>Settings &gt; Linked Devices</strong></li>
        <li>Tap <strong>Link a Device</strong> and scan this code</li>
      </ol>
      <p id="status">Waiting for scan...</p>
    </div>

    <div id="success-view" class="waiting">
      <div class="success">&#10003;</div>
      <p style="font-size:18px; margin-bottom:16px;">Connected!</p>
      <p style="color:#888;">You can close this page. Claude can now access your WhatsApp messages.</p>
    </div>
  </div>

  <script>
    const accountId = "{{ACCOUNT_ID}}";
    async function poll() {
      try {
        const res = await fetch('/api/status/' + accountId);
        const data = await res.json();
        if (data.authenticated) {
          document.getElementById('qr-view').classList.add('waiting');
          document.getElementById('success-view').classList.remove('waiting');
          return; // stop polling
        }
        if (data.qr_data_url) {
          const img = document.getElementById('qr-img');
          img.src = data.qr_data_url;
          document.getElementById('spinner').style.display = 'none';
          img.style.display = 'block';
        }
      } catch {}
      setTimeout(poll, 2000);
    }
    poll();
  </script>
</body>
</html>`;

async function applyQR(accountId: string, qrString: string): Promise<void> {
  try {
    const dataUrl = await QRCode.toDataURL(qrString, {
      width: 256,
      margin: 0,
      color: { dark: "#000000", light: "#ffffff" },
    });
    const session = sessions.get(accountId);
    if (session) session.qrDataUrl = dataUrl;
  } catch (err) {
    log(`QR generation error: ${err}`);
  }
}

export function startQRServer(
  bridge: WhatsAppBridge,
  port = 3456,
  initialQr?: string,
  dataDir?: string,
  accountId = "default"
): void {
  const session = getOrCreateSession(bridge, accountId);

  // Convert the QR string immediately
  if (initialQr) applyQR(accountId, initialQr);

  // Keep updating on subsequent QR refreshes (only attach once per bridge)
  if (!(bridge as any)._qrListenerAttached) {
    bridge.on("qr", (qrString: string) => {
      applyQR(accountId, qrString);
    });

    bridge.on("connected", () => {
      session.authenticated = true;
      // Clean up session after page shows success
      setTimeout(() => {
        sessions.delete(accountId);
        // Stop server if no more sessions
        if (sessions.size === 0) stopQRServer();
      }, 30_000);
    });

    (bridge as any)._qrListenerAttached = true;
  }

  // Start HTTP server if not already running
  if (!server) {
    server = createServer((req, res) => {
      const url = req.url ?? "/";

      // /setup or /setup/ → default account
      // /setup/{accountId} → specific account
      if (url === "/setup" || url === "/setup/" || url === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(setupHtml("default"));
        return;
      }

      const setupMatch = url.match(/^\/setup\/([^/?]+)/);
      if (setupMatch) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(setupHtml(setupMatch[1]));
        return;
      }

      // /api/status/{accountId}
      const statusMatch = url.match(/^\/api\/status\/([^/?]+)/);
      if (statusMatch) {
        const id = statusMatch[1];
        const s = sessions.get(id);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
        });
        res.end(
          JSON.stringify({
            authenticated: s?.authenticated ?? false,
            qr_data_url: s?.qrDataUrl ?? null,
          })
        );
        return;
      }

      // Legacy /api/status → default account
      if (url === "/api/status") {
        const s = sessions.get("default");
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
        });
        res.end(
          JSON.stringify({
            authenticated: s?.authenticated ?? false,
            qr_data_url: s?.qrDataUrl ?? null,
          })
        );
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        log(`Port ${port} in use, trying ${port + 1}`);
        server?.listen(port + 1);
      } else {
        log(`QR server error: ${err.message}`);
      }
    });

    server.listen(port, () => {
      const actualPort = (server?.address() as any)?.port ?? port;
      log(`Setup page: http://localhost:${actualPort}/setup`);
    });
  }

  // Only auto-open browser on first-time setup (no existing auth)
  const hasExistingAuth = dataDir && existsSync(join(dataDir, "whatsmeow.db"));
  if (!hasExistingAuth) {
    // Wait briefly for listen to succeed, then open browser with actual port
    setTimeout(() => {
      const actualPort = (server?.address() as any)?.port ?? port;
      const setupUrl = accountId === "default"
        ? `http://localhost:${actualPort}/setup`
        : `http://localhost:${actualPort}/setup/${accountId}`;
      openBrowser(setupUrl);
    }, 500);
  } else {
    log(`QR generated during reconnect for "${accountId}" — not auto-opening browser`);
  }
}

export function stopQRServer(): void {
  if (server) {
    server.close();
    server = null;
    sessions.clear();
    log("QR server stopped");
  }
}

async function openBrowser(url: string): Promise<void> {
  try {
    const open = (await import("open")).default;
    await open(url);
  } catch {
    log(`Open ${url} in your browser to connect WhatsApp`);
  }
}
