// @ts-check
// Rules against a fake box: the calls and their inputs, the grouping, the draft checks before an owner's proof is asked, and who refused.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const RULE = (id, kind, extra = {}) => ({ id, kind, binds: ["assistants"], covers: { actions: ["mail.send"] }, label: `L ${id}`, view: `V ${id}`, status: "active", at: 1, ...extra });

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    if (o[tool]) return o[tool];
    if (tool === "rules.list") return { data: { rules: [RULE("r3", "always_ask", { at: 3, approver: { role: "owner" } }), RULE("r1", "never", { at: 1 }), RULE("r2", "never", { at: 2 }), RULE("rx", "never", { status: "disabled", at: 9 })], proposals: [RULE("prop_1", "draft_only", { by: { kind: "agent", id: "kit" } }), RULE("prop_2", "never", { by: { kind: "person", id: "per_a" } })] } };
    return { data: { id: "rule_new" } };
  };
  return { call, seen };
}

test("the list groups active rules by kind in a fixed order, and the sentence is the kernel's view", { skip: !strip }, async () => {
  const { rulesSource } = await import("./source.ts");
  const { groups, proposer, disabled } = await import("./model.ts");
  const b = box();
  const l = await rulesSource(b.call).listReal("spc_1");
  assert.deepEqual(b.seen, [{ tool: "rules.list", input: { space: "spc_1" } }]);
  assert.deepEqual(groups(l.rules).map((g) => [g.title, g.rules.map((r) => r.id)]), [["Never", ["r1", "r2"]], ["Always ask", ["r3"]]]);
  assert.equal(groups(l.rules)[0].rules[0].view, "V r1");
  assert.deepEqual(disabled(l.rules).map((r) => r.id), ["rx"]);
  assert.deepEqual(l.proposals.map(proposer), ["the assistant kit", "a member"]);
});

test("define, propose, enable, disable, accept, dismiss and remove are one call each; the id-only calls carry only the id", { skip: !strip }, async () => {
  const { rulesSource } = await import("./source.ts");
  const b = box({ "rules.dismiss": { data: { dismissed: "prop_1" } }, "rules.remove": { data: { removed: "r1" } } });
  const s = rulesSource(b.call);
  const rule = { kind: "never", binds: ["assistants"], covers: { actions: ["mail.send"] }, label: "No mail" };
  await s.setReal(rule, "spc_1"); await s.proposeReal(rule); await s.enableReal("r2"); await s.disableReal("r2"); await s.acceptReal("prop_9"); await s.dismissReal("prop_1"); await s.removeReal("r1");
  assert.deepEqual(b.seen, [
    { tool: "rules.define", input: { space: "spc_1", rule } }, { tool: "rules.propose", input: { rule } }, { tool: "rules.enable", input: { id: "r2" } }, { tool: "rules.disable", input: { id: "r2" } }, { tool: "rules.accept", input: { id: "prop_9" } },
    { tool: "rules.dismiss", input: { id: "prop_1" } }, { tool: "rules.remove", input: { id: "r1" } },
  ]);
});

test("a draft is checked before the owner's proof is asked, and built into the kernel's shape", { skip: !strip }, async () => {
  const { build, parseActions } = await import("./model.ts");
  const d = { kind: "always_ask", binds: ["members", "assistants"], actions: "mail.send, Calendar.Write\nmail.send", resource: "", approverKind: "role", approver: "owner", label: " Josh approves dates " };
  assert.deepEqual(parseActions(d.actions), { actions: ["mail.send", "calendar.write"], bad: [] });
  assert.deepEqual(build(d), { rule: { kind: "always_ask", binds: ["assistants", "members"], covers: { actions: ["mail.send", "calendar.write"] }, approver: { role: "owner" }, label: "Josh approves dates" } });
  assert.match(/** @type {any} */ (build({ ...d, actions: "send" })).error, /send is not an action name/);
  assert.match(/** @type {any} */ (build({ ...d, actions: "rules.set" })).error, /rules.set is not an action name/);
  assert.match(/** @type {any} */ (build({ ...d, approver: "" })).error, /role that approves/);
  assert.match(/** @type {any} */ (build({ ...d, binds: [] })).error, /who it binds/);
  assert.deepEqual(/** @type {any} */ (build({ ...d, kind: "never", resource: " vyre://s/mailbox/* " })).rule, { kind: "never", binds: ["assistants", "members"], covers: { actions: ["mail.send", "calendar.write"], resource: "vyre://s/mailbox/*" }, label: "Josh approves dates" });
});

test("a refusal says which rule refused it, from the decision or an error's detail", { skip: !strip }, async () => {
  const { refusedBy, ruleRefusal } = await import("./model.ts");
  assert.equal(refusedBy({ rule: { id: "r1", kind: "never", label: "No mail to clients" } }), "Refused by the rule: No mail to clients");
  assert.equal(refusedBy({ detail: { rule: { kind: "always_ask", label: "Josh approves dates" } } }), "Waiting on the rule: Josh approves dates");
  assert.equal(refusedBy({ rule: { kind: "draft_only", label: "Drafts only" } }), "Kept as a draft by the rule: Drafts only");
  assert.equal(refusedBy({ effect: "deny" }), null);
  assert.deepEqual([ruleRefusal("not_allowed", ""), ruleRefusal("presence_required", "")].map((x) => x.length > 10), [true, true]);
});
