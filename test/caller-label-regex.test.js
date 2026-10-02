// The shapes of a caller label are parsed in one place. core/modules/index.js (callerKind, agentClaim,
// canonicalCaller) and lib/caller.js (isPerson) own the regexes; everything else reads a label through
// them, so a fix reaches every tool at once (reviewer-2, 2 Oct 2026: forty files each kept a regex for
// "agent:" or "thread:", and several matched only the agent, or only one case). This counts the regex
// literals for an agent or thread claim in every other source file against test/caller-label-regex.json:
// a file may not gain one, and a line there is a debt each owner pays by calling agentClaim, CLAIM or
// isPerson instead. It reads files only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNERS = new Set(["core/modules/index.js", "lib/caller.js", "local/hands-chrome-mac/caller.js"]);
const RX = /(?<![\w)\]"'`])\/(?![/*])(?:[^/\n\\]|\\.)*(?:agent|thread):(?:[^/\n\\]|\\.)*\/[gimsuy]*/g;
const allow = JSON.parse(fs.readFileSync(path.join(root, "test", "caller-label-regex.json"), "utf8")).files;

function* sources(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "testing"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (/\.m?js$/.test(e.name) && !e.name.endsWith(".test.js")) yield p;
  }
}

test("caller-label regexes for an agent or thread claim stay in core/modules and lib/caller.js", () => {
  const counts = {};
  for (const top of ["core", "lib", "local", "apps", "modules", "packages"]) {
    const dir = path.join(root, top);
    if (!fs.existsSync(dir)) continue;
    for (const f of sources(dir)) {
      const rel = path.relative(root, f).split(path.sep).join("/");
      if (OWNERS.has(rel)) continue;
      let n = 0;
      for (const line of fs.readFileSync(f, "utf8").split("\n")) { if (/^\s*(\/\/|\*)/.test(line)) continue; n += (line.match(RX) || []).length; }
      if (n) counts[rel] = n;
    }
  }
  const more = Object.entries(counts).filter(([f, n]) => n > (allow[f] || 0)).map(([f, n]) => `${f}: ${n} (allowed ${allow[f] || 0})`).sort();
  assert.deepEqual(more, [], "read a caller label through agentClaim, CLAIM or isPerson (core/modules, lib/caller) instead of a new regex");
  const stale = Object.keys(allow).filter(f => (counts[f] || 0) < allow[f]).sort();
  assert.deepEqual(stale, [], "lower these counts in test/caller-label-regex.json: the regexes were removed");
});
