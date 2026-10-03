// @ts-check
// Boundaries: every part talks to another part only through the registry (ctx.call, tools) and
// events, never by importing its files (team rule "Modularity", 2026-09-27). The kernel is the
// exception: core/config, store, events, modules, presence and daemon may be imported by anyone.
// So is lib/<name>, shared pure code with no feature state (ADR 0033): any part may import a lib,
// and a lib may import only the kernel and other libs, never a feature.
//
// A part is core/<name> (a folder, or a single file such as core/quiet.js), local/<name> or
// modules/<name>. This scans every runtime .js/.mjs/.cjs file under those trees (tests, testing/
// and fixtures are out of scope: a test may reach into what it tests) for relative imports,
// static, dynamic or require, and fails on any that lands in another part's files unless ALLOW
// below lists that edge AND that exact target file. ALLOW froze the edges main had on
// 2026-09-27; it only shrinks. A new edge needs the lead's OK. An entry nothing uses any more
// fails too, so a fixed edge comes off the list. docs/architecture/boundaries.md explains each.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "./scratch.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const KERNEL = new Set(["config", "store", "events", "modules", "presence", "daemon"].map(n => "core/" + n));
const TREES = ["core", "local", "modules", "lib"];

/**
 * The frozen exceptions: "from -> to" with the files `from` imports, why, and what it becomes
 * (ctx.call: go through the registry; lib: move the helper to a kernel folder or its own small
 * lib with no feature state; surface: the CLI is a surface and may keep its command helpers).
 * @type {Record<string, { files: string[], why: string, next: "ctx.call" | "lib" | "surface" | "host" }>}
 */
export const ALLOW = {
  "core/cli -> core/names": { files: ["core/names/backup.js", "core/names/system.js"], next: "ctx.call",
    why: "vyre backup and vyre up write the box backup and the systemd unit in-process" },
  "core/cli -> core/recall": { files: ["core/recall/embed.js", "core/recall/progress.js"], next: "ctx.call",
    why: "vyre status and doctor read index progress and the embedder's state directly" },
  "core/cli -> core/resilience": { files: ["core/resilience/backoff.js", "core/resilience/node.js", "core/resilience/stream.js"], next: "lib",
    why: "the reference client every surface uses; a pure library with no feature state" },
  "core/cli -> core/vault": { files: ["core/vault/backup.js", "core/vault/cli-io.js", "core/vault/refs.js"], next: "surface",
    why: "vyre vault's terminal side: no-echo prompts, vault:// refs and the sealed backup format" },
  "core/cli -> local/voice": { files: ["local/voice/talk.js"], next: "ctx.call",
    why: "vyre voice, push-to-talk from a terminal until the native Capsule has voice" },
  "core/daemon -> core/harness": { files: ["core/harness/rules.js"], next: "lib",
    why: "the kernel runs the security floor on every call's input; the floor belongs in the kernel" },
  "core/daemon -> core/names": { files: ["core/names/guests.js"], next: "ctx.call",
    why: "the router asks whether a tailnet caller is a guest before it reaches the registry" },
  "core/daemon -> core/switchboard": { files: ["core/switchboard/sessions.js"], next: "ctx.call",
    why: "the router resolves which Claude Code session a call comes from" },
  "core/files -> core/link": { files: ["core/link/transport.js"], next: "lib",
    why: "Mac to box file transfer over the tailnet transport" },
  "core/files -> core/names": { files: ["core/names/tailscale.js"], next: "lib",
    why: "runs the tailscale CLI (Taildrive); tailscale.js is the one place that does" },
  "core/hooks -> core/names": { files: ["core/names/tailscale.js"], next: "lib",
    why: "runs the tailscale CLI" },
  "core/link -> core/names": { files: ["core/names/tailscale.js"], next: "lib",
    why: "finds the box on the tailnet through the tailscale CLI" },
  "core/names -> core/link": { files: ["core/link/transport.js"], next: "lib",
    why: "names and link import each other: transport belongs in a small lib both use" },
  "core/network -> core/names": { files: ["core/names/guests.js", "core/names/identity.js", "core/names/tailscale.js"], next: "lib",
    why: "the listeners identify tailnet peers (ADR 0002); identity and tailscale are shared helpers" },
  "core/onboard -> core/names": { files: ["core/names/service.js", "core/names/tailscale.js"], next: "ctx.call",
    why: "onboarding reserves the name and starts the tailnet listener in-process" },
  "core/recall -> core/transcripts": { files: ["core/transcripts/index.js"], next: "lib",
    why: "transcripts is the one reader of Claude Code's files, a library with no feature state" },
  "core/watchers -> core/spawner": { files: ["core/spawner/client.js"], next: "lib",
    why: "the box's watcher wall is the root spawner's (spawnAsWatcher); until the client is a lib the wall candidate loads it, and only when a spawner socket exists" },
  "core/sessions -> core/spawner": { files: ["core/spawner/client.js"], next: "ctx.call",
    why: "sessions/switchboard split (ADR 0030), cleanup owed by sessions after 0.1.0" },
  "core/sessions -> core/switchboard": { files: ["core/switchboard/runner.js"], next: "ctx.call",
    why: "sessions/switchboard split (ADR 0030), cleanup owed by sessions after 0.1.0" },
  "core/sessions -> core/transcripts": { files: ["core/transcripts/sanitize.js"], next: "ctx.call",
    why: "sessions/switchboard split (ADR 0030), cleanup owed by sessions after 0.1.0" },
  "core/switchboard -> core/harness": { files: ["core/harness/rules.js"], next: "ctx.call",
    why: "sessions/switchboard split (ADR 0030), cleanup owed by sessions after 0.1.0" },
  "core/switchboard -> core/sessions": { files: ["core/sessions/config.js", "core/sessions/providers.js", "core/sessions/sdk.js", "core/sessions/spawn.js"], next: "ctx.call",
    why: "sessions/switchboard split (ADR 0030), cleanup owed by sessions after 0.1.0" },
  "core/switchboard -> core/transcripts": { files: ["core/transcripts/sanitize.js"], next: "lib",
    why: "keeps credentials out of what it builds from transcripts" },
  "core/term -> core/files": { files: ["core/files/safety.js"], next: "ctx.call",
    why: "the path gate every file path passes through" },
  "core/vyre-core -> core/vault": { files: ["core/vault/vault.js"], next: "host",
    why: "vyre-core hosts the vault's store and crypto in its own process and db (ADR 0040 phase 2); permanent by design, lead's OK pending" },
  "core/vault -> core/link": { files: ["core/link/transport.js"], next: "lib",
    why: "vault relay between the Mac and the box" },
  "core/vault -> core/names": { files: ["core/names/identity.js", "core/names/tailscale.js"], next: "lib",
    why: "who is on the other end of a vault relay, and the tailscale CLI" },
  "local/capsule -> core/cli": { files: ["core/cli/commands/capsule-native.js"], next: "lib",
    why: "where the native Capsule app is built, shared with vyre capsule" },
  "local/hands-mac -> local/screen-mac": { files: ["local/screen-mac/floor.js"], next: "lib",
    why: "the floor for Vyre's hands and eyes on the Mac (SPEC section 11)" },
  "local/sideview -> local/screen-mac": { files: ["local/screen-mac/floor.js", "local/screen-mac/runner.js"], next: "ctx.call",
    why: "drives the sight helper and its floor directly" },
};

/** @param {string} rel repo-relative path */
function partOf(rel) {
  const p = rel.split("/");
  if (!TREES.includes(p[0]) || p.length < 2) return null;
  if (p[0] === "core" && p.length === 2) return "core/" + p[1].replace(/\.(m?js|cjs)$/, "");
  return p[0] + "/" + p[1];
}

const outOfScope = rel => /\.test\.(m?js|cjs)$/.test(rel) || /(^|\/)(testing|test|fixtures|node_modules)(\/|$)/.test(rel);

/** Every cross-part import in the runtime tree: Map<"from -> to", Set<target file>>. */
export function scan(root = ROOT) {
  /** @type {string[]} */
  const files = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(m?js|cjs)$/.test(e.name)) files.push(f);
    }
  };
  for (const t of TREES) if (fs.existsSync(path.join(root, t))) walk(path.join(root, t));
  const re = /(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;
  /** @type {Map<string, Set<string>>} */
  const edges = new Map();
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join("/");
    if (outOfScope(rel)) continue;
    const from = partOf(rel);
    for (const m of fs.readFileSync(f, "utf8").matchAll(re)) {
      const spec = m[1] || m[2] || m[3] || m[4];
      if (!spec.startsWith(".")) continue;
      const target = path.relative(root, path.resolve(path.dirname(f), spec)).split(path.sep).join("/");
      const to = partOf(target);
      if (!to || !from || to === from || KERNEL.has(to) || to.startsWith("lib/")) continue;
      const k = `${from} -> ${to}`;
      if (!edges.has(k)) edges.set(k, new Set());
      /** @type {Set<string>} */ (edges.get(k)).add(target);
    }
  }
  return edges;
}

test("boundaries: parts import only the kernel, or a frozen exception", () => {
  const found = scan();
  const problems = [];
  for (const [edge, targets] of found) {
    const allowed = ALLOW[edge];
    if (!allowed) { problems.push(`${edge} (${[...targets].join(", ")}) is a new edge: go through ctx.call or events, or ask the lead to freeze it`); continue; }
    for (const t of targets) if (!allowed.files.includes(t)) problems.push(`${edge} now also imports ${t}: not frozen`);
  }
  assert.deepEqual(problems, []);
});

test("boundaries: a lib imports only the kernel and other libs, never a feature", () => {
  const bad = [...scan()].filter(([edge]) => edge.startsWith("lib/")).map(([edge, t]) => `${edge} (${[...t].join(", ")})`);
  assert.deepEqual(bad, []);
  assert.ok(Object.keys(ALLOW).every(edge => !edge.startsWith("lib/")), "no lib edge may be frozen");
});

test("boundaries: the allowlist only shrinks (an edge nothing uses comes off)", () => {
  const found = scan();
  const stale = [];
  for (const [edge, { files }] of Object.entries(ALLOW)) {
    const now = found.get(edge);
    if (!now) { stale.push(`${edge}: no longer imported, remove it from ALLOW and the doc`); continue; }
    for (const f of files) if (!now.has(f)) stale.push(`${edge}: ${f} no longer imported, remove it`);
  }
  assert.deepEqual(stale, []);
});

test("boundaries: docs/architecture/boundaries.md lists every frozen edge", () => {
  const doc = fs.readFileSync(path.join(ROOT, "docs", "architecture", "boundaries.md"), "utf8");
  const missing = Object.keys(ALLOW).filter(edge => !doc.includes("`" + edge + "`"));
  assert.deepEqual(missing, []);
});

test("boundaries: the scan sees static, dynamic and require imports, and skips the kernel and tests", () => {
  const root = fs.mkdtempSync(path.join(SCRATCH, "vyre-boundaries-"));
  try {
    const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), s); };
    w("core/a/index.js", `import { x } from "../b/x.js";\nconst y = await import("../c/y.js");\nimport "../store/index.js";\n`);
    w("core/a/old.cjs", `const z = require("../d/z.js");\n`);
    w("core/a/a.test.js", `import { q } from "../e/q.js";\n`);
    w("local/l/index.js", `export { v } from "../../core/f/v.js";\nimport { t } from "../../lib/tailnet/index.js";\n`);
    w("lib/tailnet/index.js", `import { c } from "../../core/config/index.js";\nimport { r } from "../retry/index.js";\nimport { n } from "../../core/names/x.js";\n`);
    const edges = Object.fromEntries([...scan(root)].map(([k, v]) => [k, [...v]]));
    assert.deepEqual(edges, {
      "core/a -> core/b": ["core/b/x.js"], "core/a -> core/c": ["core/c/y.js"], "core/a -> core/d": ["core/d/z.js"],
      "local/l -> core/f": ["core/f/v.js"], "lib/tailnet -> core/names": ["core/names/x.js"],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
