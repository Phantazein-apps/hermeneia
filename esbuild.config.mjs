import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 1. Bundle Node.js MCP server
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: "dist/index.js",
  sourcemap: false,
  minify: false,
  external: [],
  banner: {
    js: `
import { createRequire } from 'module';
import { fileURLToPath as _furl } from 'url';
import { dirname as _dn } from 'path';
const require = createRequire(import.meta.url);
const __filename = _furl(import.meta.url);
const __dirname = _dn(__filename);
`.trim(),
  },
});

// 2. Copy sql-wasm.wasm alongside the bundle
mkdirSync("dist", { recursive: true });
const wasmSrc = resolve(__dirname, "node_modules/sql.js/dist/sql-wasm.wasm");
copyFileSync(wasmSrc, resolve(__dirname, "dist/sql-wasm.wasm"));

// 3. Build Go bridge binary — skippable via HERMENEIA_SKIP_GO_BUILD for
// callers that only need the TS/store layer (e.g. the demo-mode smoke test,
// which never spawns the Go binary at all).
//
// The bridge is pure Go (modernc.org/sqlite, no CGO), so it cross-compiles
// to any GOOS/GOARCH from any host. By default we build for the host
// platform; BRIDGE_GOOS/BRIDGE_GOARCH override for CI cross-builds. The
// output is named to match bridge.ts's resolver exactly (win32→windows,
// x64→amd64, ".exe" on Windows).
if (process.env.HERMENEIA_SKIP_GO_BUILD === "1") {
  console.log("Built dist/index.js (+ sql-wasm.wasm) — Go bridge build skipped");
} else {
  const goBridgeDir = resolve(__dirname, "go-bridge");
  // Detect native arch — Node/Go may run under Rosetta on Apple Silicon
  function detectArch() {
    if (process.platform === "darwin") {
      try {
        if (execSync("/usr/sbin/sysctl -n hw.optional.arm64").toString().trim() === "1") return "arm64";
      } catch {}
    }
    return process.arch === "x64" ? "amd64" : process.arch;
  }
  const nativeArch = detectArch();

  const goos = process.env.BRIDGE_GOOS || (process.platform === "win32" ? "windows" : process.platform);
  const goarch = process.env.BRIDGE_GOARCH || nativeArch;
  const ext = goos === "windows" ? ".exe" : "";
  const outName = `hermeneia-bridge-${goos}-${goarch}${ext}`;

  try {
    console.log(`Building Go bridge (${goos}/${goarch}, CGO disabled)...`);
    execSync(`go build -trimpath -ldflags="-s -w" -o ../dist/${outName} .`, {
      cwd: goBridgeDir,
      stdio: "inherit",
      env: { ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch },
    });
    // Also drop a generic-named copy so bridge.ts's dev fallback path
    // (dist/hermeneia-bridge) keeps working when building for the host.
    if (!process.env.BRIDGE_GOOS && !process.env.BRIDGE_GOARCH) {
      copyFileSync(resolve(__dirname, "dist", outName), resolve(__dirname, "dist", `hermeneia-bridge${ext}`));
    }
    console.log(`Built dist/index.js + dist/${outName} (+ sql-wasm.wasm)`);
  } catch (err) {
    console.error("Go build failed — Node.js bundle was still created");
    process.exit(1);
  }
}
