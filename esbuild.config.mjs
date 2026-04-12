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

// 3. Build Go bridge binary for current platform
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
try {
  console.log(`Building Go bridge (${process.platform}/${nativeArch})...`);
  execSync("go build -o ../dist/hermeneia-bridge .", {
    cwd: goBridgeDir,
    stdio: "inherit",
    env: { ...process.env, CGO_ENABLED: "1", GOARCH: nativeArch },
  });
  console.log("Built dist/index.js + dist/hermeneia-bridge (+ sql-wasm.wasm)");
} catch (err) {
  console.error("Go build failed — Node.js bundle was still created");
  process.exit(1);
}
