// Single-instance lockfile.
//
// Claude Desktop sometimes launches the same MCP server twice — once via its
// internal Node utility service and once via the external `node` command —
// which produces two Hermeneia instances competing over the same whatsmeow
// session and ping-ponging "Stream replaced" on every tool call.
//
// This module enforces single-instance semantics: the second process detects
// a live peer via a PID file and exits cleanly, leaving the first instance
// with sole ownership of the WhatsApp bridge.

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const log = (msg: string) => console.error(`[hermeneia:lock] ${msg}`);

let lockPath: string | null = null;

/** Try to acquire the lock. Returns true if acquired, false if another
 *  instance holds it (caller should exit cleanly in that case). */
export function acquireLock(dataDir: string): boolean {
  mkdirSync(dataDir, { recursive: true });
  lockPath = join(dataDir, "hermeneia.pid");

  if (existsSync(lockPath)) {
    const raw = readFileSync(lockPath, "utf-8").trim();
    const pid = parseInt(raw, 10);
    if (pid > 0 && isAlive(pid)) {
      log(`Another Hermeneia is already running (PID ${pid}) — exiting cleanly.`);
      return false;
    }
    log(`Stale lock (PID ${raw}) — taking over.`);
  }

  writeFileSync(lockPath, String(process.pid));
  log(`Lock acquired (PID ${process.pid})`);

  // Best-effort release on clean exit. SIGKILL will leave a stale file, which
  // the next startup's staleness check handles.
  const release = () => {
    try {
      if (lockPath && existsSync(lockPath)) {
        const raw = readFileSync(lockPath, "utf-8").trim();
        if (parseInt(raw, 10) === process.pid) {
          unlinkSync(lockPath);
        }
      }
    } catch {}
  };
  process.on("exit", release);
  process.on("SIGINT", () => { release(); process.exit(0); });
  process.on("SIGTERM", () => { release(); process.exit(0); });

  return true;
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 tests whether we can send signals to the process without
    // actually sending one. Throws if the process doesn't exist.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
