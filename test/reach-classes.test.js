// BR-2: the caller classes that are not the person's (a browser `web:<id>`, a setup page `setup:<id>`) reach only their own short lists, and a label nobody recognises reaches nothing.
// The lists live in core/modules/agent-reach.js; this checks them against the tools and the setup gate they describe, so a new tool cannot join a class by accident.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WEB_REACH, SETUP_REACH } from "../core/modules/agent-reach.js";
import { classReach, callerAllowed, callerKind, KNOWN_LABELS, SURFACE_LABELS } from "../core/modules/index.js";
import { SETUP_TOOLS, SETUP_TOOL_FAMILIES } from "../core/relay/setup.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = "web:" + "a".repeat(16), SETUP = "setup:" + "b".repeat(16);

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "image") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.js$/.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(p);
  }
}

test("WEB_REACH is exactly the tools that declare callers: [\"web\"]", () => {
  /** @type {string[]} */ const files = []; walk(path.join(REPO, "core"), files);
  const declared = new Set();
  for (const f of files) for (const m of fs.readFileSync(f, "utf8").matchAll(/ctx\.tool\("([a-z0-9.-]+)",\s*\{\s*callers:\s*\["web"\]/g)) declared.add(m[1]);
  assert.deepEqual([...declared].sort(), [...WEB_REACH.keys()].sort());
});

test("SETUP_REACH is the relay's setup gate plus the tools a module declares under setupTools, each with a reason", () => {
  /** @type {string[]} */ const mods = [];
  const find = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === "node_modules") continue; const p = path.join(d, e.name); if (e.isDirectory()) find(p); else if (e.name === "module.json") mods.push(p); } };
  find(path.join(REPO, "core"));
  const extra = mods.flatMap(f => JSON.parse(fs.readFileSync(f, "utf8")).setupTools || []);
  for (const t of SETUP_TOOLS) assert.ok(SETUP_REACH.has(t), `${t} is in the setup gate but not in SETUP_REACH`);
  for (const t of extra) assert.ok(SETUP_REACH.has(t), `${t} is a module's setupTools but not in SETUP_REACH`);
  for (const [t, why] of SETUP_REACH) {
    assert.ok(SETUP_TOOLS.has(t) || SETUP_TOOL_FAMILIES.some(r => r.test(t)) || extra.includes(t), `${t} is in SETUP_REACH but the setup gate does not let it through`);
    assert.ok(typeof why === "string" && why.length > 8, `${t} has no reason`);
  }
});

test("a browser reaches only WEB_REACH and a setup page only SETUP_REACH, whatever a tool's callers says", () => {
  assert.equal(classReach(WEB, "wink.phone.wait"), true);
  assert.equal(classReach(WEB, "names.claim"), false);
  assert.equal(classReach(WEB, undefined), false);
  assert.equal(classReach(SETUP, "names.claim"), true);
  assert.equal(classReach(SETUP, "wink.phone.wait"), false);
  assert.equal(classReach(SETUP, "vault.get"), false);
  assert.equal(callerAllowed(null, WEB, "memory.search"), false, "a tool open to anyone is still not open to a browser");
  assert.equal(callerAllowed(["web"], WEB, "memory.search"), false, "naming web is not enough, the class list decides");
  assert.equal(callerAllowed(["cli"], "cli", "memory.search"), true);
});

test("a label nobody recognises reaches nothing, a known one goes on to the tool's own list", () => {
  assert.equal(classReach("zz:1", "memory.search"), false);
  assert.equal(callerAllowed(null, "zz:1", "memory.search"), false);
  for (const l of ["cli", "deck", "capsule", "mobile", "mcp:agent:kit", "module:notes", "device:abc", "tailnet:alex@example.com", "tailnet-guest:x", "unknown", "anonymous"]) assert.equal(classReach(l, "memory.search"), null, l);
  assert.equal(callerKind(WEB), "web");
  assert.ok(KNOWN_LABELS.has("web") && KNOWN_LABELS.has("setup"));
});

test("every surface label is known, and so is the first word of every label the code builds", () => {
  for (const l of SURFACE_LABELS) assert.ok(KNOWN_LABELS.has(l), l);
  /** @type {string[]} */ const files = [];
  for (const d of ["core", "lib", "relay", "local", "modules", "names", "records", "stores", "kernel"]) if (fs.existsSync(path.join(REPO, d))) walk(path.join(REPO, d), files);
  /** @type {string[]} */ const unknown = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/\bcaller(?::|\s*=)\s*[`"']([a-z][a-z0-9-]*)(?=[:`"'\s])/g)) if (!KNOWN_LABELS.has(m[1])) unknown.push(`${path.relative(REPO, f)}: ${m[1]}`);
  }
  assert.deepEqual([...new Set(unknown)].sort(), [], "a label the code builds has a first word the registry would refuse; add it to KNOWN_LABELS in core/modules/index.js");
});
