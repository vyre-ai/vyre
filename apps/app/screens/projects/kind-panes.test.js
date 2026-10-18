import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { kindTabs, emailQuery, boardColumns, automationsOf, flowsHere } from "./kind-panes.js";

test("a client project adds Client and Emails, an Ongoing one adds Board and Flows, and Stages, Simple and Personal add none", () => {
  assert.deepEqual(kindTabs({ kind: "client" }), ["client", "emails"]);
  assert.deepEqual(kindTabs({ kind: "ongoing" }), ["board", "flows"]);
  for (const d of [{ kind: "stages" }, { kind: "simple" }, {}, undefined, { personal_of: "per_x", kind: "client" }]) assert.deepEqual(kindTabs(d), []);
});

test("the Emails tab searches the client's addresses, each once, and says nothing when there is none", () => {
  assert.equal(emailQuery({ email: "dana@northwind.example" }), "from:dana@northwind.example OR to:dana@northwind.example");
  assert.equal(emailQuery({ email: "Dana@Northwind.example", emails: ["dana@northwind.example", { value: "d2@x.example" }, "not an address"] }), "from:dana@northwind.example OR to:dana@northwind.example OR from:d2@x.example OR to:d2@x.example");
  assert.equal(emailQuery({ name: "No mail" }), null);
  assert.equal(emailQuery(undefined), null);
});

test("the board puts every task in To do, Doing or Done, newest change first", () => {
  const t = (id, state, updated_at) => ({ id, state, updated_at });
  const cols = boardColumns([t("a", "ready", 1), t("b", "working", 2), t("c", "done", 3), t("d", "skipped", 4), t("e", "waiting", 5), t("f", "stuck", 6), t("g", "needs_check", 7)]);
  assert.deepEqual(cols.map((c) => c.label), ["To do", "Doing", "Done"]);
  assert.deepEqual(cols.map((c) => c.tasks.map((x) => x.id)), [["e", "a"], ["g", "f", "b"], ["d", "c"]]);
  assert.equal(cols.reduce((n, c) => n + c.tasks.length, 0), 7, "no task is lost");
});

test("the Flows a project turns on come from its pinned stages; an unreadable snapshot gives none", () => {
  const snap = JSON.stringify({ stages: [{ name: "Launch" }], automations: [{ flow: "new_lead_followup", when: "Launch", note: "turns on here" }, { flow: "welcome", when: "start" }, { nope: 1 }] });
  assert.deepEqual(automationsOf(snap), [{ flow: "new_lead_followup", when: "Launch", note: "turns on here" }, { flow: "welcome", when: "start" }]);
  assert.deepEqual(automationsOf("{not json"), []);
  assert.deepEqual(automationsOf(undefined), []);
});

test("the Runs-on-its-own list is the Flows that name the project, then the playbook's automations they do not already cover", () => {
  const rows = [{ id: "flw_1", name: "new_lead_followup", label: "Follow up new leads", line: "Ran 2 hours ago", active: true }, { id: "flw_2", name: "weekly_digest", active: false }];
  const autos = [{ flow: "new_lead_followup", when: "Launch" }, { flow: "welcome", when: "start" }, { flow: "wrap_up_email", when: "Wrap up", note: "sends the summary" }];
  assert.deepEqual(flowsHere(rows, autos).map((r) => [r.title, r.sub]), [
    ["Follow up new leads", "Ran 2 hours ago"], ["weekly_digest", "Off"], ["welcome", "Runs when the project starts"], ["wrap up email", "Runs in Wrap up, sends the summary"],
  ]);
  assert.deepEqual(flowsHere([], []), []);
  assert.equal(flowsHere([{ id: "x" }], [])[0].sub, "Runs here");
});
