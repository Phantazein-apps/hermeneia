// Desktop notifications for user-visible Hermeneia events.
// macOS-only (osascript). No-op on other platforms.

import { spawn } from "child_process";

export function notify(title: string, body: string): void {
  if (process.platform !== "darwin") return;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    const proc = spawn(
      "osascript",
      ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`],
      { stdio: "ignore", detached: true }
    );
    proc.on("error", () => {});
    proc.unref();
  } catch {}
}
