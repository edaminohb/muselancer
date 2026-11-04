import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.join(process.cwd(), "node_modules", "@privy-io", "react-auth", "dist");
const isActiveNeedle = 'isActive:l?"true":"false",';
const signNeedles = [
  "let{method:R,data:j,confirmAndSign:L,onSuccess:U,onFailure:A,uiOptions:N}=s.signMessage",
  "let{method:R,data:b,confirmAndSign:P,onSuccess:_,onFailure:f,uiOptions:q}=a.signMessage",
];

function walk(directory) {
  let isActive = 0;
  let sign = 0;
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name);
    if (statSync(file).isDirectory()) {
      const nested = walk(file);
      isActive += nested.isActive;
      sign += nested.sign;
      continue;
    }
    if (!file.endsWith(".js") && !file.endsWith(".mjs")) continue;
    let source = readFileSync(file, "utf8");
    let next = source;
    if (next.includes(isActiveNeedle)) {
      next = next.replaceAll(isActiveNeedle, "");
      isActive += 1;
    }
    for (const needle of signNeedles) {
      const data = needle.includes("s.signMessage") ? "s" : "a";
      const guarded = `if(!${data}.signMessage)return null;${needle}`;
      if (next.includes(guarded) || !next.includes(needle)) continue;
      next = next.replaceAll(needle, guarded);
      sign += 1;
    }
    if (next !== source) writeFileSync(file, next);
  }
  return { isActive, sign };
}

if (!statSync(root, { throwIfNoEntry: false })) process.exit(0);
const changed = walk(root);
if (changed.isActive > 0) console.log(`Removed unused Privy isActive props from ${changed.isActive} file(s).`);
if (changed.sign > 0) console.log(`Guarded Privy sign screen in ${changed.sign} file(s).`);
