// Desktop notifications for user-visible Hermeneia events.
//
// Two critical events fire these: WhatsApp revoked the linked device
// (the user must re-scan a QR), and the watchdog gave up after repeated
// failed respawns. Losing them on non-Mac platforms would make a dead
// session invisible — worst on a headless Refugio/Linux host. So we notify
// per-platform AND always write to the log, which is the one channel that
// exists everywhere (including headless).

import { spawn } from "child_process";

const log = (msg: string) => console.error(`[hermeneia:notify] ${msg}`);

function notifyMac(title: string, body: string): void {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const proc = spawn(
    "osascript",
    ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`],
    { stdio: "ignore", detached: true }
  );
  proc.on("error", () => {});
  proc.unref();
}

function notifyWindows(title: string, body: string): void {
  // PowerShell balloon-tip toast — no external dependency. Escape single
  // quotes for the PowerShell single-quoted string literals.
  const esc = (s: string) => s.replace(/'/g, "''");
  const script =
    `[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');` +
    `$n = New-Object System.Windows.Forms.NotifyIcon;` +
    `$n.Icon = [System.Drawing.SystemIcons]::Information;` +
    `$n.BalloonTipTitle = '${esc(title)}';` +
    `$n.BalloonTipText = '${esc(body)}';` +
    `$n.Visible = $true;` +
    `$n.ShowBalloonTip(10000);` +
    `Start-Sleep -Seconds 10;` +
    `$n.Dispose()`;
  const proc = spawn(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
    { stdio: "ignore", detached: true }
  );
  proc.on("error", () => {});
  proc.unref();
}

function notifyLinux(title: string, body: string): void {
  // Only meaningful when a graphical session exists; on a headless host
  // (no DISPLAY/WAYLAND_DISPLAY) skip silently — the log line still fires.
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
  const proc = spawn("notify-send", ["--app-name=Hermeneia", title, body], {
    stdio: "ignore",
    detached: true,
  });
  proc.on("error", () => {});
  proc.unref();
}

export function notify(title: string, body: string): void {
  // The log channel is unconditional — it's the only one that reaches a
  // headless operator, and it's where every desktop notification is also
  // recoverable after the fact.
  log(`${title} — ${body}`);

  try {
    switch (process.platform) {
      case "darwin":
        notifyMac(title, body);
        break;
      case "win32":
        notifyWindows(title, body);
        break;
      case "linux":
        notifyLinux(title, body);
        break;
      // Other platforms: the log line above is the alert.
    }
  } catch {
    // Never let a notification failure affect the caller.
  }
}
