// Hermeneia — Web-based QR code auth page
//
// Starts a tiny local HTTP server that displays the WhatsApp QR code
// in a browser instead of the terminal. Auto-opens on first run.

import { createServer, type Server } from "http";
import QRCode from "qrcode";
import type { WhatsAppBridge } from "./bridge.js";

const log = (msg: string) => console.error(`[hermeneia:qr] ${msg}`);

let server: Server | null = null;
let currentQRDataUrl: string | null = null;
let isAuthenticated = false;

const SETUP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hermeneia — Connect WhatsApp</title>
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
    }
    #qr-container img { display: block; width: 256px; height: 256px; }
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
    <p class="subtitle">Connect your WhatsApp account to Claude</p>

    <div id="qr-view">
      <div id="qr-container">
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
    async function poll() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        if (data.authenticated) {
          document.getElementById('qr-view').classList.add('waiting');
          document.getElementById('success-view').classList.remove('waiting');
          return; // stop polling
        }
        if (data.qr_data_url) {
          document.getElementById('qr-img').src = data.qr_data_url;
        }
      } catch {}
      setTimeout(poll, 2000);
    }
    poll();
  </script>
</body>
</html>`;

async function applyQR(qrString: string): Promise<void> {
  try {
    currentQRDataUrl = await QRCode.toDataURL(qrString, {
      width: 256,
      margin: 0,
      color: { dark: "#000000", light: "#ffffff" },
    });
  } catch (err) {
    log(`QR generation error: ${err}`);
  }
}

export function startQRServer(bridge: WhatsAppBridge, port = 3456, initialQr?: string): void {
  // If already running, just update the QR (WhatsApp refreshes every ~20s)
  if (server) {
    if (initialQr) applyQR(initialQr);
    return;
  }

  // Convert the QR string that triggered this call immediately — don't wait for next event
  if (initialQr) applyQR(initialQr);

  // Keep updating on subsequent QR refreshes
  bridge.on("qr", (qrString: string) => {
    applyQR(qrString);
  });

  bridge.on("connected", () => {
    isAuthenticated = true;
    // Keep server running briefly so the page can show success
    setTimeout(() => stopQRServer(), 30_000);
  });

  server = createServer((req, res) => {
    if (req.url === "/setup" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(SETUP_HTML);
      return;
    }

    if (req.url === "/api/status") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      });
      res.end(
        JSON.stringify({
          authenticated: isAuthenticated,
          qr_data_url: currentQRDataUrl,
        })
      );
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(port, () => {
    log(`Setup page: http://localhost:${port}/setup`);
  });

  // Try to auto-open the browser
  openBrowser(`http://localhost:${port}/setup`);
}

export function stopQRServer(): void {
  if (server) {
    server.close();
    server = null;
    log("QR server stopped");
  }
}

async function openBrowser(url: string): Promise<void> {
  try {
    const open = (await import("open")).default;
    await open(url);
  } catch {
    // Silently fail — user can open manually
    log(`Open ${url} in your browser to connect WhatsApp`);
  }
}
