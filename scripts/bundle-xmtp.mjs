import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const sdk = path.join(root, "node_modules", "@xmtp", "browser-sdk");
const out = path.join(root, "public", "xmtp");
const workerOut = path.join(out, "worker");

function esbuild(args) {
  const result = spawnSync("npx", ["--yes", "esbuild", ...args], { cwd: root, stdio: "inherit", shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

mkdirSync(workerOut, { recursive: true });
esbuild(["node_modules/@xmtp/browser-sdk/entry.js", "--bundle", "--format=esm", "--outfile=public/xmtp/client.js", "--loader:.wasm=file"]);
esbuild([
  "node_modules/@xmtp/browser-sdk/typescript-wasm/worker-entry.gen.js",
  "--bundle",
  "--format=esm",
  "--outfile=public/xmtp/worker/worker-entry.gen.js",
  "--loader:.wasm=file",
]);

copyFileSync(path.join(sdk, "typescript-pure", "xmtp_sdk.wasm"), path.join(out, "xmtp_sdk.wasm"));
copyFileSync(path.join(sdk, "typescript-wasm", "xmtp_sdk.wasm"), path.join(workerOut, "xmtp_sdk.wasm"));

const clientPath = path.join(out, "client.js");
const workerUrl = 'new URL("./worker-entry.gen.js", import.meta.url)';
const client = readFileSync(clientPath, "utf8");
if (!client.includes(workerUrl)) {
  console.error("The XMTP client bundle has no worker URL to retarget.");
  process.exit(1);
}
writeFileSync(clientPath, client.replaceAll(workerUrl, 'new URL("./worker/worker-entry.gen.js", import.meta.url)'));
rmSync(path.join(out, "worker-entry.gen.js"), { force: true });
