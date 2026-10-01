// A tool's reach (who may call it) must be written down, never defaulted. A manifest entry with no
// `reach` defaults to "anyone" in the registry, so a forgotten line is an open door (found in the
// names.* review). This reads every module.json and fails on a tool with no explicit `reach` that is
// not in test/reach-allowlist.json, and on an allowlist line that is stale (the tool now declares a
// reach, or no longer exists). Each owner shrinks the allowlist by writing { "name": ..., "reach": ... }.
// It reads files only; it boots nothing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const skip = new Set(["node_modules", ".git", "testing"]);
function* manifests(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* manifests(p);
    else if (e.name === "module.json") yield p;
  }
}

/** Tool name -> { module, explicit } over every first-party manifest. */
function tools() {
  const out = new Map();
  for (const top of ["core", "local", "modules", "apps"]) {
    const dir = path.join(root, top);
    if (!fs.existsSync(dir)) continue;
    for (const f of manifests(dir)) {
      let m;
      try { m = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
      if (!m || typeof m.name !== "string") continue;
      const list = m.does && Array.isArray(m.does.tools) ? m.does.tools : [];
      for (const t of list) {
        if (typeof t === "string") out.set(t, { module: m.name, explicit: false });
        else if (t && typeof t.name === "string") out.set(t.name, { module: m.name, explicit: typeof t.reach === "string" && t.reach !== "" });
      }
    }
  }
  return out;
}

const allow = JSON.parse(fs.readFileSync(path.join(root, "test", "reach-allowlist.json"), "utf8")).tools;

test("every tool declares an explicit reach, except the ones the allowlist names", () => {
  const all = tools();
  const missing = [...all].filter(([name, t]) => !t.explicit && !(name in allow)).map(([name, t]) => `${t.module}: ${name}`).sort();
  assert.deepEqual(missing, [], "write { \"name\": ..., \"reach\": ... } for these tools in their module.json (anyone is fine when deliberate)");
});

test("the reach allowlist only names tools that still lack a reach", () => {
  const all = tools();
  const stale = Object.keys(allow).filter(name => !all.has(name) || all.get(name)?.explicit).sort();
  assert.deepEqual(stale, [], "delete these lines from test/reach-allowlist.json: the tool now declares a reach or is gone");
});
