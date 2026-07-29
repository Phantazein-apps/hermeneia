// Hermeneia — Web-based QR code auth page
//
// Starts a tiny local HTTP server that displays the WhatsApp QR code
// in a browser instead of the terminal. Supports multiple accounts
// via /setup/{accountId} routes.

import { createServer, type Server } from "http";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
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

// Installed by the BridgeManager. Kept as a hook rather than an import so this
// module has no dependency on the manager, and so the page degrades to
// read-only if a host wires up the server without one.
let relinkHandler: ((accountId: string) => Promise<void>) | null = null;
export function setRelinkHandler(fn: (accountId: string) => Promise<void>): void {
  relinkHandler = fn;
}

// Tracks accounts whose setup page we've already auto-opened in this process,
// so subsequent QR regenerations / bridge respawns don't pop new browser tabs.
const autoOpenedAccounts = new Set<string>();

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
    #relink {
      margin-top: 20px; padding: 10px 18px; cursor: pointer;
      background: #25D366; color: #06281a; border: 0; border-radius: 8px;
      font-size: 14px; font-weight: 600;
    }
    #relink:disabled { opacity: .55; cursor: default; }
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
      <div id="idle" class="waiting">
        <p style="color:#ccc; font-size:15px; line-height:1.6;">
          This account is already linked, so there is no code to scan.
        </p>
        <p style="color:#888; font-size:13px; margin-top:8px;">
          If WhatsApp still isn't working, the phone may have unlinked this
          device. Re-linking asks for a fresh code.
        </p>
        <button id="relink">Re-link this phone</button>
        <p id="relink-msg" style="color:#888; font-size:13px; margin-top:12px;"></p>
      </div>
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
          showPairing(true);
        } else if (!data.pairing) {
          // Linked and not pairing. Spinning "Connecting..." forever at someone
          // whose account is simply offline is the state this page used to be
          // unreachable in, so it must not be the state it lies in either.
          showPairing(false, data.can_relink);
        }
      } catch {}
      setTimeout(poll, 2000);
    }

    function showPairing(isPairing, canRelink) {
      document.getElementById('qr-container').style.display = isPairing ? '' : 'none';
      document.querySelector('.steps').style.display = isPairing ? '' : 'none';
      document.getElementById('status').style.display = isPairing ? '' : 'none';
      document.getElementById('idle').classList.toggle('waiting', isPairing);
      if (!isPairing) document.getElementById('relink').style.display = canRelink ? '' : 'none';
    }

    document.getElementById('relink').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const msg = document.getElementById('relink-msg');
      btn.disabled = true;
      msg.textContent = 'Asking WhatsApp for a new code...';
      try {
        const res = await fetch('/api/relink/' + accountId, { method: 'POST' });
        if (!res.ok) throw new Error((await res.json()).error || 'failed');
        msg.textContent = 'Waiting for the code...';
      } catch (err) {
        btn.disabled = false;
        msg.textContent = String(err.message || err);
      }
    });

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
      // Drop the finished pairing session, but LEAVE THE SERVER UP. Stopping
      // it once nothing was pairing is what made the setup page a dead link:
      // an account that is paired-but-offline emits no QR, so nothing ever
      // restarted the server, and the host's "open setup" action led nowhere.
      setTimeout(() => { sessions.delete(accountId); }, 30_000);
    });

    (bridge as any)._qrListenerAttached = true;
  }

  ensureSetupServer(port);

  // Only auto-open browser on first-time setup.
  // Check accounts.json for a saved phone number — if present, the account
  // was previously authenticated (this is a reconnect, don't open browser).
  // We can't check whatsmeow.db existence because the Go bridge creates it
  // before generating the QR code.
  let hasExistingAuth = false;
  try {
    if (dataDir) {
      const accountsPath = join(dataDir, "..", "accounts.json");
      if (existsSync(accountsPath)) {
        const accounts = JSON.parse(readFileSync(accountsPath, "utf-8"));
        hasExistingAuth = accounts.some((a: any) => a.id === accountId && a.phone);
      }
    }
  } catch {}
  // Only auto-open the browser the FIRST time we emit a QR for this account
  // in this process. whatsmeow regenerates QRs (every ~14 min when one expires)
  // and our manager respawns bridges on exit — both fire "qr" events that
  // land here. Without dedupe, each one pops a new browser tab, producing the
  // "QR window loop" the user sees. The setup page polls /api/status for fresh
  // QRs, so a single open tab is sufficient.
  if (!hasExistingAuth && !autoOpenedAccounts.has(accountId)) {
    autoOpenedAccounts.add(accountId);
    setTimeout(() => {
      const actualPort = (server?.address() as any)?.port ?? port;
      const setupUrl = accountId === "default"
        ? `http://localhost:${actualPort}/setup`
        : `http://localhost:${actualPort}/setup/${accountId}`;
      openBrowser(setupUrl);
    }, 500);
  } else if (hasExistingAuth) {
    log(`QR generated during reconnect for "${accountId}" — not auto-opening browser`);
  } else {
    log(`QR regenerated for "${accountId}" — setup page already open, not reopening`);
  }
}

/**
 * Start the setup server, whether or not anything is currently pairing.
 *
 * The page has something useful to say in every state: a QR when pairing is
 * needed, and otherwise the account's actual condition plus a way to re-link.
 * Starting it only on a QR event meant the one state where a user most wants
 * to visit it — linked but not connecting — was the state where it did not
 * exist.
 */
export function ensureSetupServer(port = 3456): void {
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
            // No pairing session at all is a distinct state from "pairing, no
            // QR yet". Without it the page spins "Connecting…" forever at
            // someone whose account is linked and simply offline.
            pairing: !!s,
            can_relink: !!relinkHandler,
          })
        );
        return;
      }

      // Re-link: drop the stored session so the bridge asks for a new QR. This
      // is the actual remedy when WhatsApp has dropped the linked device —
      // reconnecting cannot fix that, only re-pairing can.
      const relinkMatch = url.match(/^\/api\/relink\/([^/?]+)/);
      if (relinkMatch && req.method === "POST") {
        const id = relinkMatch[1];
        if (!relinkHandler) {
          res.writeHead(501, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "re-linking is not available in this host" }));
          return;
        }
        relinkHandler(id).then(
          () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); },
          (e) => {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: String(e?.message || e) }));
          }
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

}

export function stopQRServer(): void {
  if (server) {
    server.close();
    server = null;
    sessions.clear();
    log("QR server stopped");
  }
}

/** Open the setup page, or tell the user where to find it.
 *
 *  Spawned directly rather than via the `open` package. That package's child
 *  emits its failure asynchronously, so `try { await open(url) } catch` does
 *  NOT catch a missing opener binary — the 'error' event reaches no listener
 *  and Node terminates the process. The observed result is brutal: Hermeneia
 *  logs "MCP server running on stdio", then dies half a second later while
 *  trying to pop a browser tab, and the client only sees the connection close.
 *
 *  Spawning here means the error handler is attached in the same tick, which
 *  is the same shape notify.ts already uses for the same reason. Opening a
 *  browser is a convenience; it must never be able to take down the server. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] :
    process.platform === "win32"  ? ["cmd", ["/c", "start", "", url]] :
    ["xdg-open", [url]];

  const proc = spawn(cmd, args, { stdio: "ignore", detached: true });
  proc.on("error", () => log(`Open ${url} in your browser to connect WhatsApp`));
  proc.unref();
}
