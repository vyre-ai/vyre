// @ts-check
// FOUNDATION S3: who did something is set by the kernel from the call's own chain, never read from the call's input. Two halves. (1) Every tool a person or a model can reach whose input has a field that
// could name a person (created_by, owner, person, as, by, approver, ...) is listed here with WHY that field is not the caller's identity: a TARGET the act is about (the kernel authorizes acting on
// them), a LOOKUP key, a DESIGNATION (who should decide, not who did), a name the module IGNORES, or the kernel-off SHIM. A new such field fails until someone reviews it; a rule with no field fails
// (so the list cannot rot). (2) The ones where a forged value would be a real lie are tried: the value is sent, and the record carries the caller. A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const FIELD = /^(created_by|createdBy|owner|person|as|actor|author|by|user|decided_by|approver|proposer|requested_by|who|member|sender|asker)$/;

/** tool-name pattern, field, class, reason. A rule covers every tool its pattern matches that has the field. */
const RULES = /** @type {[RegExp, string, "target"|"lookup"|"designation"|"narrowing"|"shim"|"caller", string][]} */ ([
  [/^spaces\./, "person", "target", "an admin names the member the act is about; the role engine and the kernel authorize it against the caller's own chain"],
  [/^spaces\./, "member", "target", "the person whose computer is lent or stopped; authorized against the caller's own chain"],
  [/^bridges\./, "person", "target", "the person whose view or reference is read or shared; the bridge checks the caller's own chain can act for them"],
  [/^vault\.(emergency\.|members\.|offboard$)/, "person", "target", "the person added, removed or asked of; the Vault checks the caller's own chain"],
  [/^vault\.emergency\./, "owner", "target", "whose vault an emergency request is for; checked against the caller's chain"],
  [/^vault\.relay$/, "owner", "target", "the owner whose vault is relayed; callers cli, local, module only"],
  [/^wink\.(server|storage)\./, "owner", "target", "what the server or storage belongs to: yourself by default, or a Space you administer; checked against the caller's chain"],
  [/^github\.repo\.create$/, "owner", "target", "the GitHub account or organisation the repo is made under, not a Vyre person"],
  [/^publish\.create$/, "approver", "designation", "who should approve, not who created it; created_by is the caller's chain"],
  [/^threads\.(start|send)$/, "asker", "caller", "first-party stream only: core/stream sets it from the chat's own kernel session; a plain caller's value is not read as the person"],
  [/^gate\./, "by", "caller", "the caller's label is stamped; a `by` sent is not read (core/gate/module.test.js proves it)"],
  [/^planner\./, "as", "narrowing", "only a person's own label may send it (the Mac forwards an agent's call to the box), and it only makes the call LESS than the person: a named non-person source, never another person (core/planner who())"],
  [/^stream\./, "as", "shim", "read only when the kernel is off (the legacy-label shim); with the kernel on the chain's person wins (core/stream/group.js personOf)"],
  [/^undo\.list$/, "actor", "lookup", "a filter on whose actions to list"],
]);

test("every identity-looking field on a tool a person or model can reach is reviewed, and every review is still true", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "alex", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  /** @type {string[]} */ const seen = [], unreviewed = [];
  for (const [name, def] of d.registry.tools) {
    const callers = Array.isArray(def.callers) ? def.callers : null;
    if (def.internal || (callers && callers.every((/** @type {string} */ c) => c === "module"))) continue; // a module's own call has the chain of the person it runs for
    for (const [field, p] of Object.entries((def.input && def.input.properties) || {})) {
      if (!FIELD.test(field)) continue;
      const type = /** @type {any} */ (p).type;
      if (type === "boolean" || type === "number" || type === "integer" || Array.isArray(/** @type {any} */ (p).enum)) continue; // a flag, an amount or a mode word names nobody
      seen.push(`${name}.${field}`);
      if (!RULES.some(([re, f]) => f === field && re.test(name))) unreviewed.push(`${name}.${field}`);
    }
  }
  assert.ok(seen.length > 60, `the scan found the fields it is meant to review (${seen.length})`);
  assert.deepEqual(unreviewed, [], "a tool takes a field that could name a person: say why it is not the caller's identity (RULES), or stop reading it");
  const stale = RULES.filter(([re, f]) => !seen.some(s => { const i = s.lastIndexOf("."); return s.slice(i + 1) === f && re.test(s.slice(0, i)); })).map(([re, f]) => `${re} ${f}`);
  assert.deepEqual(stale, [], "a rule matches no tool any more: delete it");
  for (const [, , , why] of RULES) assert.ok(why.length > 25, "every rule says why");
});

test("a planner call's `as` can only make it less than the caller: a named non-person source, never another person", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "alex", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const as = async (/** @type {string} */ tool, /** @type {any} */ input = {}, caller = "cli") => d.registry.call(tool, input, caller, { token: (await d.kernel.surfaces.open(owner, {})).token });
  // a person's own label may narrow itself to an agent source
  const narrowed = await as("planner.add", { kind: "note", title: "from the forward", as: { source: "agent:juno", name: "juno" } });
  assert.ok(!narrowed.error, JSON.stringify(narrowed.error));
  // a model's label may not send it at all: its `as` is not read, it stays the model
  const model = await d.registry.call("planner.add", { kind: "todo", title: "forged", as: { source: "cli", name: "per_forged" } }, "mcp");
  assert.ok(!/per_forged/.test(JSON.stringify(model.data || {})), "a model's `as` is not read");
});
