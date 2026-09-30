#!/usr/bin/env node
// build-release: the standalone package as one folder (and a .tar.gz), with nothing from the rest
// of the repo in it. `node build-release.mjs [--out DIR]` writes DIR/vyre-chrome/ and
// DIR/vyre-chrome-<version>.tar.gz plus its sha256.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");

/** Files and folders of local/hands-chrome-mac that the standalone needs, relative to it. */
const KEEP = ["index.js", "bridge.js", "oversight.js", "floor-url.js", "caller.js", "extension", "native-host",
  "standalone/cli.mjs", "standalone/runtime.js", "standalone/mcp.js", "standalone/trace.js", "standalone/GHL-PLAYBOOK.md"];
const SKIP = /(\.test\.js|node-path|sock-path)$/;

/** @param {string} from @param {string} to */
function copy(from, to) {
  const st = fs.statSync(from);
  if (st.isDirectory()) { fs.mkdirSync(to, { recursive: true }); for (const f of fs.readdirSync(from)) if (!SKIP.test(f)) copy(path.join(from, f), path.join(to, f)); return; }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/** @param {{ out: string }} o */
export function build({ out }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "extension", "manifest.json"), "utf8"));
  const version = manifest.version;
  const dir = path.join(out, "vyre-chrome");
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of KEEP) copy(path.join(SRC, k), path.join(dir, k));
  fs.copyFileSync(path.join(SRC, "standalone", "README.md"), path.join(dir, "README.md"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "vyre-chrome", version, private: true, type: "module", description: "Vyre for Chrome: control your own Chrome from Claude Code. No server.", engines: { node: ">=22" }, bin: { "vyre-chrome": "standalone/cli.mjs" } }, null, 2) + "\n");
  fs.chmodSync(path.join(dir, "standalone", "cli.mjs"), 0o755);
  const tar = path.join(out, `vyre-chrome-${version}.tar.gz`);
  const r = spawnSync("tar", [...(process.platform === "win32" ? ["--force-local"] : []), "-czf", tar, "-C", out, "vyre-chrome"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
  const sha = crypto.createHash("sha256").update(fs.readFileSync(tar)).digest("hex");
  fs.writeFileSync(`${tar}.sha256`, `${sha}  ${path.basename(tar)}\n`);
  return { dir, tar, sha, version };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const i = process.argv.indexOf("--out");
  const out = path.resolve(i >= 0 ? process.argv[i + 1] : "dist");
  fs.mkdirSync(out, { recursive: true });
  const r = build({ out });
  console.log(`built ${r.tar}\nsha256 ${r.sha}`);
}
