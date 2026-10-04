import "../scripts/mac-test-guard.mjs";
// The lead's ruling on MH-1 and MS-1: `mcp` and `harness` in any form are model callers and never the person, and there is ONE answer in one place: lib/caller.js isPerson(caller) (true only for a person's
// own surface or device) and modelKey(caller) (the agent a named model claims, or `caller:<kind>` for one that names no one; null only for the person). A module-local helper that maps a caller label to
// the person or to an owner is how an unnamed `mcp` (every model's shell, since asTaken relabels each one) became the person in chrome, hands and memory. This scan finds such a helper by shape:
//   (1) a list or regex that holds a person's surface AND "mcp" and is used to decide who someone is;
//   (2) a function or arrow named for the person or the owner (owner, person, ownSession, ownerSurface, isUser, isMine ...) whose first lines test the caller's label.
// The detector is proved against three real fixtures, the helpers as they were before the fixes (chrome's agentOf, hands' grantKey, memory's reach), and must flag each. FROZEN is today's remaining helpers,
// per file, and is the sweep list (team/0.2/CHAT.md): an owner migrates one to isPerson/modelKey and lowers the number; a new one fails here. It only shrinks.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Files that ARE the one answer, or measure the label itself before any tool runs. */
const THE_ONE = new Set(["lib/caller.js", "core/modules/index.js", "core/presence/index.js", "core/daemon/index.js", "core/daemon/peer.js", "local/hands-chrome-mac/caller.js"]);
const LIST_WITH_MCP = [
  /\[[^\]]*"(?:cli|local|deck|capsule)"[^\]]*"mcp"[^\]]*\]\s*\.includes\(/,
  /\[\s*\.\.\.[A-Z_]*PEOPLE[A-Z_]*\s*,\s*"mcp"\s*\]\s*\.includes\(/,
  /\(\s*cli\s*\|\s*local\s*\|[^)]*\bmcp\b[^)]*\)/,
];
const NAMED_FOR_PERSON = /\b(?:const|let|var|function)\s+((?:is)?(?:[A-Za-z]*[Oo]wner[A-Za-z]*|[A-Za-z]*[Pp]erson[A-Za-z]*|own[A-Z][A-Za-z]*|isUser|isMine|isSelf))\b\s*(?:=|\()/;
const TESTS_THE_LABEL = /callerKind\(|String\(\s*caller|OWNER\.has|PEOPLE\.(?:includes|has)|SURFACES?\.(?:includes|has)|\/\^?\(?(?:cli|deck|local|capsule)|agentClaim\(|\.startsWith\(\s*["']module:/;

/** Findings in one source text: [line number, why]. @param {string} src */
export function helpers(src) {
  const lines = src.split("\n"), out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    if (LIST_WITH_MCP.some(re => re.test(line))) { out.push([i + 1, "a surface and mcp together decide who someone is"]); continue; }
    const m = NAMED_FOR_PERSON.exec(line);
    if (m && lines.slice(i, i + 7).some(l => TESTS_THE_LABEL.test(l))) out.push([i + 1, `${m[1]} maps a caller label to the person or an owner`]);
  }
  return out;
}

const FIXTURES = {
  "chrome agentOf, before MH-1": `const agentOf = (caller) => {
  const claim = agentClaim(caller);
  if (claim) return claim;
  return [...PEOPLE, "mcp"].includes(callerKind(caller)) ? null : \`caller:\${callerKind(caller)}\`;
};`,
  "hands grantKey, before MH-1": `const grantKey = (caller, meta) => {
  const claim = agentClaim(caller);
  if (claim) return claim;
  if (FIRST_PARTY.test(String(caller)) && meta && meta.firstParty === true) return null;
  return [...PEOPLE, "mcp"].includes(callerKind(caller)) ? null : \`caller:\${callerKind(caller)}\`;
};`,
  "memory reach, before MS-1": `const OWNER = new Set(["deck", "cli", "local", "capsule"]);
const ownSession = caller => /^mcp(?::thread:[\\w-]+)?$/.test(String(caller || ""));
const owner = caller => OWNER.has(String(caller)) || ownSession(caller) || String(caller).startsWith("module:");
const reach = async (agent, caller) => { if (!agent && owner(caller)) return { all: true }; };`,
};
test("the detector flags the three helpers that let a model be the person", () => {
  for (const [name, src] of Object.entries(FIXTURES)) assert.ok(helpers(src).length > 0, `not flagged: ${name}`);
});
test("lib/caller.js: no mcp or harness form is ever the person; every model has a key", async () => {
  const { isPerson, modelKey } = await import("../lib/caller.js");
  for (const l of ["mcp", "mcp:thread:t1", "mcp:agent:kit", "harness", "harness:thread:t1", "harness:agent:kit"]) { assert.equal(isPerson(l), false, l); assert.notEqual(modelKey(l), null, l); }
  assert.equal(modelKey("mcp:agent:kit"), "kit");
  assert.equal(modelKey("mcp"), "caller:mcp");
  for (const l of ["cli", "local", "deck", "capsule"]) { assert.equal(isPerson(l), true, l); assert.equal(modelKey(l), null, l); }
});

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "image" || e.name === "testing") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.m?js$/.test(e.name) && !/\.test\.m?js$/.test(e.name)) out.push(p);
  }
}
/** Remaining module-local helpers, per file: the sweep list. Lower a number when an owner moves one onto lib/caller.js; never add one. */
const FROZEN = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "model-is-never-person.json"), "utf8")).files;
test("no new module-local helper maps a caller label to the person or an owner (the frozen list only shrinks)", () => {
  const files = [];
  for (const top of ["core", "local", "modules", "lib", "kernel"]) { const d = path.join(ROOT, top); if (fs.existsSync(d)) walk(d, files); }
  const found = {};
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    if (THE_ONE.has(rel)) continue;
    const n = helpers(fs.readFileSync(f, "utf8")).length;
    if (n) found[rel] = n;
  }
  const over = Object.entries(found).filter(([f, n]) => n > (FROZEN[f] || 0)).map(([f, n]) => `${f}: ${n} (frozen ${FROZEN[f] || 0})`);
  assert.deepEqual(over, [], "use lib/caller.js isPerson(caller) and modelKey(caller); a model label is never the person");
  const stale = Object.keys(FROZEN).filter(f => !found[f] || found[f] < FROZEN[f]).map(f => `${f}: ${found[f] || 0} (frozen ${FROZEN[f]})`);
  assert.deepEqual(stale, [], "lower these numbers in test/model-is-never-person.json (an owner fixed one)");
});
