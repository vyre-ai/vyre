// A module that calls a tool through the registry is a "module" caller. The registry refuses a module
// caller on a tool whose reach is "asked" (unless the person's own words asked for exactly that), "person" or
// "hook", so a module calling one breaks the first time it runs (found in the reach pass: agents.stop
// stopping threads through threads.stop, onboard asking an agent). This reads every first-party module's
// source for literal ctx.call("x.y"), call("x.y") and use("x.y") and fails when the callee's reach
// would refuse a module. It reads files only; it boots nothing. A call that runs for the person on
// purpose (a person-proxy path) goes in PERSON_PROXY with the reason.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", ".git", "testing"]);
/** "module:tool" pairs that pass a person's own caller or a said row on purpose. */
const PERSON_PROXY = new Set([
  // A tolerated refusal: the switchboard asks mentions.search and, when a module is refused it, falls back to vault by name (core/switchboard/said.js).
  "switchboard:mentions.search",
  // The Windows app's own page (local/capsule/native-win/app/ui/link.js) asks the box through the person's signed-in panel; it is the person calling, not a module.
  "capsule:files.drive.address",
  // pluginagent.revoke is the person's own act (it needs presence): the agent it made is deleted with the revoking caller (ctx.call as: meta.caller), so agents.delete's person-only rule decides, not the module.
  "pluginagent:agents.delete",
  // core/wink/serverlink.js askApproval / approvalStatus: a paired device asks for its owner's yes over its own peer-wire session (sessionFor), the person's own device calling as itself, not a module.
  "wink:approvals.ask",
  "wink:approvals.status",
]);

function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else yield p;
  }
}

/** tool -> reach ("anyone" when none declared: the registry default today). */
function reaches() {
  const out = new Map();
  for (const top of ["core", "modules", "local", "apps"]) {
    const dir = path.join(root, top);
    if (!fs.existsSync(dir)) continue;
    for (const f of files(dir)) {
      if (path.basename(f) !== "module.json") continue;
      let m; try { m = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
      for (const t of (m && m.does && m.does.tools) || []) {
        if (typeof t === "string") out.set(t, "anyone");
        else if (t && t.name) out.set(t.name, t.reach || "anyone");
      }
    }
  }
  return out;
}

test("no first-party module calls, as a module, a tool whose reach refuses modules", () => {
  const reach = reaches();
  const bad = [];
  const CALL = /\b(?:ctx\.call|call|use)\(\s*["'`]([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)["'`]/g;
  for (const top of ["core", "modules", "local", "lib"]) {
    const dir = path.join(root, top);
    if (!fs.existsSync(dir)) continue;
    for (const f of files(dir)) {
      if (!/\.m?js$/.test(f) || f.endsWith(".test.js") || f.includes(`${path.sep}cli${path.sep}`)) continue;
      const mod = path.relative(dir, f).split(path.sep)[0];
      const src = fs.readFileSync(f, "utf8");
      let m;
      while ((m = CALL.exec(src))) {
        const tool = m[1], r = reach.get(tool);
        if (!r || !["asked", "person", "hook"].includes(r)) continue;
        if (tool.split(".")[0] === mod && !/ctx\.call/.test(m[0])) continue; // a module's own internal helper named call()
        if (PERSON_PROXY.has(`${mod}:${tool}`)) continue;
        bad.push(`${path.relative(root, f)}: ${tool} (reach ${r})`);
      }
    }
  }
  assert.deepEqual(bad, [], "a module calls a tool whose reach refuses a module caller: make the tool reach anyone (and scope it in code), or call an internal tool");
});

// A call whose tool name is computed (ctx.call(tool, ...)) cannot be checked here, and it runs as a module
// caller, so its target's reach must allow modules. test/reach-computed-calls.json lists the files that
// have one, with a count and who reviews them; a new computed call in any other file fails, and a count
// above the listed one fails. A call whose callee takes the caller's own name goes through the registry
// under its own reach, so this is a debt list for owners to shrink, not a pass.
const computed = JSON.parse(fs.readFileSync(path.join(root, "test", "reach-computed-calls.json"), "utf8")).files;
test("a call with a computed tool name is only in a file on the reviewed list", () => {
  const COMPUTED = /\b(?:ctx\.call|use)\(\s*([^"'`\s][^,)]*)/g;
  const counts = {};
  for (const top of ["core", "modules", "local", "lib"]) {
    const dir = path.join(root, top);
    if (!fs.existsSync(dir)) continue;
    for (const f of files(dir)) {
      if (!/\.m?js$/.test(f) || f.endsWith(".test.js") || f.includes(`${path.sep}cli${path.sep}`)) continue;
      const rel = path.relative(root, f).split(path.sep).join("/");
      let n = 0, m;
      const src = fs.readFileSync(f, "utf8");
      while ((m = COMPUTED.exec(src))) if (!/^["'`]/.test(m[1].trim())) n++;
      if (n) counts[rel] = n;
    }
  }
  const more = Object.entries(counts).filter(([f, n]) => n > ((computed[f] || {}).count || 0)).map(([f, n]) => `${f}: ${n} (listed ${(computed[f] || {}).count || 0})`).sort();
  assert.deepEqual(more, [], "a module calls a tool by a computed name: use a literal name, or review it and list the file in test/reach-computed-calls.json");
  const stale = Object.keys(computed).filter(f => (counts[f] || 0) < computed[f].count).sort();
  assert.deepEqual(stale, [], "lower these counts in test/reach-computed-calls.json");
});

// A relay mark in a call's meta (`relayedBy`) would let a tool trust "the registry relayed this": only core/modules/index.js may ever write one (reviewer-3, plugin grant). Today nothing writes it; this keeps it that way.
test("only core/modules/index.js may write a `relayedBy` mark", () => {
  const bad = [];
  for (const top of ["core", "modules", "local", "lib", "kernel", "harness"]) {
    const dir = path.join(root, top);
    if (!fs.existsSync(dir)) continue;
    for (const f of files(dir)) {
      if (!/\.m?js$/.test(f) || f.endsWith(".test.js")) continue;
      const rel = path.relative(root, f).split(path.sep).join("/");
      if (rel === "core/modules/index.js") continue;
      if (/\brelayedBy\b/.test(fs.readFileSync(f, "utf8"))) bad.push(rel);
    }
  }
  assert.deepEqual(bad, [], "only the registry marks a relayed call");
});
