// @ts-check
// A recurring class of bug (e2e review, 28 Sep, latest instance files.receive before this fix): a
// tool whose callers list names only the person's own surfaces (cli, local, deck, capsule -- never
// module, mcp, tailnet or a guest) reads as person-only, but core/daemon's floor block (the
// `personal` check in core/daemon/index.js, core/daemon/peer.js's own-process test) only refused a
// `claude`/thread process for a tool core/presence's hand-kept PERSON_ONLY named, or one that asked
// for presence itself. A tool with person-only callers and neither of those was left checking only
// `callerAllowed`'s caller-kind string, which a model's own shell can claim ("cli") exactly as a
// real terminal would -- so it slipped a model straight past what its own callers list meant to
// keep out. A sweep of every module found dozens more once files.receive turned this up.
//
// Fixed default-deny: core/presence's `personOnly(name, def)` treats a tool as person-only when its
// declared callers are person-surfaces alone, unless the tool is in the explicit, reviewed OPT_OUT
// list (harmless even under a spoofed "cli"). This file has two guards: every real tool's callers
// agree with personOnly() (loads modules for real the way docs:ref does: scripts/lib/docs/reference.js's
// harvest, a sandboxed child process, throwaway home, nothing it starts can reach outside), and
// OPT_OUT itself may only shrink -- growing it needs the reviewer's own sign-off, same shape as
// test/boundaries.test.js's ALLOW.

import { test } from "node:test";
import assert from "node:assert/strict";
import { harvest } from "../scripts/lib/docs/reference.js";
import { personOnly, OPT_OUT, PERSON_SURFACES } from "../core/presence/index.js";

test("presence: every tool whose callers are person-only surfaces is treated as person-only (PERSON_ONLY or the derived default), unless explicitly opted out", () => {
  const data = harvest();
  const bad = [];
  for (const role of /** @type {const} */ (["box", "local"])) {
    for (const [moduleName, m] of Object.entries(data[role])) {
      for (const t of /** @type {any} */ (m).tools || []) {
        if (t.internal || t.hook) continue; // internal carriers and hooks are not a caller's own choice
        if (!Array.isArray(t.callers) || t.callers.length === 0) continue; // no callers list: open to any caller kind, not person-only
        const surfacesOnly = t.callers.every((/** @type {string} */ c) => PERSON_SURFACES.has(c));
        if (!surfacesOnly) continue;
        // Protected either way: PERSON_ONLY/derived (personOnly() true) or a deliberate, named
        // exemption (OPT_OUT). Only a tool that is neither is the actual gap.
        if (!personOnly(t.name, t) && !OPT_OUT.has(t.name)) bad.push(`${t.name} (${moduleName}/${role}): callers ${JSON.stringify(t.callers)} are person-only surfaces, not in PERSON_ONLY or OPT_OUT`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

// The reviewer's sign-off on today's OPT_OUT (core/presence/index.js), one line of reason each
// there. Growing this list needs a fresh review; taking an entry off (protecting one more tool) is
// always fine and needs no permission.
const REVIEWED_OPT_OUT = new Set([
  "tips.next", "tips.seen", "tips.used", "tips.dismiss", "tips.whatsnew", "tips.reset",
  "learn.skill-dismiss",
  "voice.status", "voice.settings", "voice.speak",
  "capsule.report",
  "link.find",
  "link.signout",
]);

test("presence: OPT_OUT only shrinks (a new entry needs the reviewer's own sign-off)", () => {
  const grew = [...OPT_OUT].filter(name => !REVIEWED_OPT_OUT.has(name));
  assert.deepEqual(grew, [], `OPT_OUT grew without review: ${grew.join(", ")}`);
});

test("presence: OPT_OUT names nothing the reviewer's protect list covers", () => {
  // link.pair/unpair, vault.device.join/revoke, vault.vaults.create, files.drive.mount/unmount/open,
  // files.send, agents.delete, memory.correct/merge/split, and anything else that sends, pairs,
  // joins or changes what is remembered must never be opted out (team lead + reviewer, 28 Sep).
  const MUST_PROTECT = new Set(["link.pair", "link.unpair", "vault.device.join", "vault.device.revoke",
    "vault.vaults.create", "files.drive.mount", "files.drive.unmount", "files.drive.open", "files.send",
    "agents.delete", "memory.correct", "memory.uncorrect", "memory.merge", "memory.split", "memory.read"]);
  const violated = [...OPT_OUT].filter(name => MUST_PROTECT.has(name));
  assert.deepEqual(violated, []);
});
