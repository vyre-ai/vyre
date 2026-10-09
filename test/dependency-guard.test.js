// @ts-check
// R031-00b: a new dependency needs one line that says why no existing one serves (ALLOWED-NEW.md). This test reads every manifest and fails on a dependency with no line in
// test/allowed-dependencies.json, on a line with no real reason, on a line for a dependency that is gone, and on a package that server code imports without any manifest declaring it.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = JSON.parse(fs.readFileSync(path.join(ROOT, "test/allowed-dependencies.json"), "utf8"));

/** Tracked files, or every file under the root when this is a copied tree. */
function allFiles() {
  try { const out = execFileSync("git", ["ls-files"], { cwd: ROOT, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }).toString().split("\n").filter(Boolean); if (out.length > 100) return out; } catch { /* not a checkout */ }
  /** @type {string[]} */ const out = [];
  const walk = (/** @type {string} */ dir) => { for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) { if (e.name === "node_modules" || e.name === ".git") continue; const rel = dir ? `${dir}/${e.name}` : e.name; if (e.isDirectory()) walk(rel); else out.push(rel); } };
  walk("");
  return out;
}
const read = (/** @type {string} */ f) => fs.readFileSync(path.join(ROOT, f), "utf8");

/** @returns {Record<string, string[]>} manifest path to the dependency names it declares */
function declared() {
  /** @type {Record<string, string[]>} */ const out = {};
  const ci = new Set();
  for (const f of allFiles()) {
    if (/(^|\/)package\.json$/.test(f) && !/fixtures\//.test(f)) {
      const p = JSON.parse(read(f));
      const names = Object.keys({ ...p.dependencies, ...p.devDependencies, ...p.optionalDependencies, ...p.peerDependencies });
      if (names.length) out[f] = names;
    } else if (/(^|\/)Cargo\.toml$/.test(f)) {
      const names = []; let inDep = false;
      for (const l of read(f).split("\n")) { if (/^\[/.test(l)) { inDep = /dependencies\]$/.test(l.trim()); continue; } const m = inDep && /^([A-Za-z0-9_-]+)\s*=/.exec(l); if (m) names.push(m[1]); }
      if (names.length) out[f] = names;
    } else if (/(^|\/)go\.mod$/.test(f)) {
      const t = read(f), names = [...t.matchAll(/^require\s+(\S+)\s+\S+\s*$/gm)].map(m => m[1]);
      for (const b of t.matchAll(/require \(([\s\S]*?)\)/g)) for (const l of b[1].split("\n")) { const m = /^\s*(\S+)\s+\S+(\s*\/\/\s*indirect)?\s*$/.exec(l); if (m && !m[2]) names.push(m[1]); }
      if (names.length) out[f] = names;
    } else if (/build\.gradle(\.kts)?$/.test(f)) {
      const names = [...read(f).matchAll(/(?:implementation|api|compileOnly|classpath)\s*\(?\s*["']([^"':]+:[^"':]+)(?::[^"']*)?["']/g)].map(m => m[1]);
      if (names.length) out[f] = [...new Set(names)];
    } else if (/(^|\/)Dockerfile[^/]*$/.test(f)) {
      const t = read(f);
      const npm = [...t.matchAll(/npm install -g\s+((?:"[^"]+"|\S+)(?:\s+"[^"]+")*)/g)].flatMap(m => [...m[1].matchAll(/"?(@?[a-z0-9][^"@\s]*(?:\/[^"@\s]+)?)@/gi)].map(x => x[1]));
      const images = [...t.matchAll(/^FROM\s+(\S+)/gm)].map(m => "image:" + m[1].replace(/@sha256:.*/, ""));
      const names = [...new Set([...npm, ...images])];
      if (names.length) out[f] = names;
    } else if (/^\.github\/workflows\/.*\.ya?ml$/.test(f)) {
      for (const l of read(f).split("\n")) {
        if (/npm (i|install)\b/.test(l) && !/npm ci/.test(l)) {
          for (const m of l.matchAll(/(?:^|\s)"?((?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*)@[\w.${}\-:^~"' ]*/gi)) ci.add(m[1]);
          for (const m of l.matchAll(/(?:--prefix\s+\S+\s+|--no-package-lock\s+|--no-save\s+|-g\s+|--omit=\w+\s+|--no-audit\s+|--no-fund\s+)((?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*)(?=\s|$)/gi)) ci.add(m[1]);
        }
        if (/npx --yes /.test(l)) for (const m of l.matchAll(/npx --yes (@?[a-z0-9][^@\s]*(?:\/[^@\s]+)?)/g)) ci.add(m[1]);
      }
    }
  }
  if (ci.size) out["ci:workflows"] = [...ci];
  return out;
}

test("every dependency in every manifest has a line saying why no existing one serves", () => {
  const now = declared();
  const missing = [], stale = [], weak = [];
  for (const [manifest, names] of Object.entries(now)) {
    const lines = ALLOWED.manifests[manifest] || {};
    for (const n of names) if (!lines[n]) missing.push(`${manifest}: ${n}`);
  }
  for (const [manifest, lines] of Object.entries(ALLOWED.manifests)) {
    for (const [n, why] of Object.entries(/** @type {Record<string, string>} */ (lines))) {
      if (!(now[manifest] || []).includes(n)) stale.push(`${manifest}: ${n}`);
      if (typeof why !== "string" || why.trim().length < 8 || /^(todo|tbd|needed|used)\b/i.test(why.trim())) weak.push(`${manifest}: ${n}`);
    }
  }
  assert.deepEqual(missing, [], "add each to test/allowed-dependencies.json with a line that says why no existing one serves (ALLOWED-NEW.md)");
  assert.deepEqual(stale, [], "a line for a dependency that is no longer declared: delete it");
  assert.deepEqual(weak, [], "a dependency's line must say why, in a sentence");
});

/** Node built-ins imported without the node: prefix. @param {string} n */
const builtin = n => ["fs", "net", "child_process", "crypto", "http", "https", "path", "os", "url", "dns", "stream", "zlib", "tls", "dgram", "readline", "worker_threads", "events", "util", "assert", "buffer", "querystring", "cluster", "vm", "perf_hooks", "async_hooks"].includes(n);

test("server code imports only packages some manifest declares", () => {
  const rootDeps = new Set(Object.keys(JSON.parse(read("package.json")).dependencies || {}));
  const okay = new Set([...rootDeps, ...Object.keys(ALLOWED.undeclaredImports || {})]);
  // A real import: `import ... from "x"`, a closing `} from "x"`, `import "x"`, `import("x")`, `require("x")` (not the same words in a message or a comment).
  const re = /^\s*(?:import\b[^'"]*\bfrom|\}\s*from|import)\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]/;
  const skip = /(^|\/)test\/|\.test\.|^site\/|\/vendor\/|^docs\/|\/fixtures\/|^apps\/|^examples\/|^scripts\/|^\.github\/|^tools\/|\/testing\/|legacy-fixture|^packages\//;
  /** @type {string[]} */ const found = [];
  for (const f of allFiles()) {
    if (!/\.(js|mjs|cjs)$/.test(f) || skip.test(f)) continue;
    for (const line of read(f).split("\n")) {
      if (/^\s*(\/\/|\*)/.test(line)) continue;
      const m = re.exec(line);
      if (!m) continue;
      const spec = m[1] || m[2] || m[3];
      if (spec.startsWith("node:") || spec.startsWith("@vyre/")) continue;
      const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(pkg)) continue;
      if (builtin(pkg) || okay.has(pkg)) continue;
      found.push(`${f}: ${spec}`);
    }
  }
  assert.deepEqual([...new Set(found)], [], "a package nothing declares: add it to a manifest, or to undeclaredImports in test/allowed-dependencies.json with the reason");
});
