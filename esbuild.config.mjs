import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

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

// Copy sql-wasm.wasm alongside the bundle so locateFile() can find it
mkdirSync("dist", { recursive: true });
const wasmSrc = resolve(__dirname, "node_modules/sql.js/dist/sql-wasm.wasm");
copyFileSync(wasmSrc, resolve(__dirname, "dist/sql-wasm.wasm"));

console.log("Built dist/index.js (+ sql-wasm.wasm)");
