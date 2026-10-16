import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFlow } from "../../../../kernel/flows/schema.js";
import { fromDefinition, toDefinition, newStep, stepProblem, valueSources, condExpr, SPECIAL_ACTIONS, flowSettings, setFlowSetting, actionChoices, actionPick } from "./logic.js";

import { SAMPLE_OPTIONS as O } from "../../screens/flows/starters.js";

const options = { ...O, types: [{ name: "contact", label: "Contact", fields: [{ name: "name", label: "Name", kind: "text" }] }] };
const flow = (steps) => ({ name: "Options", trigger: { kind: "created", type: "contact" }, steps });
const round = (def) => toDefinition(fromDefinition(def, options), options);

test("an agent step stored with await false stays false when the Flow is saved again", () => {
  const d = flow([{ id: "a1", kind: "agent", assistant: "teammate:juno", title: "Look", instructions: "Read it", output: { kind: "note" }, record: { expr: "event.subject" }, await: false }]);
  const draft = fromDefinition(d, options);
  assert.equal(draft.steps[0].kind, "agent", "it opens as an agent step, not an advanced one");
  const again = toDefinition(draft, options);
  assert.equal(again.steps[0].await, false);
  assert.deepEqual(checkFlow(again), []);
  const kept = flow([{ ...d.steps[0], await: true }]);
  assert.equal(round(kept).steps[0].await, true, "waiting is the default and stays");
});

test("skills on an agent or an assign step round-trip as a typed list, capped at 20 and 60 characters", () => {
  const d = flow([{ id: "a1", kind: "agent", assistant: "teammate:juno", title: "Look", instructions: "Read it", output: { kind: "note" }, record: { expr: "event.subject" }, await: true, skills: ["intake", "billing"] }]);
  const draft = fromDefinition(d, options);
  assert.equal(draft.steps[0].skills, "intake, billing");
  draft.steps[0].skills = Array.from({ length: 25 }, (_, i) => `s${i}`).join(", ");
  assert.equal(toDefinition(draft, options).steps[0].skills.length, 20);
  draft.steps[0].skills = "x".repeat(90);
  assert.equal(toDefinition(draft, options).steps[0].skills[0].length, 60);
});

test("an assign step keeps its record, await and skills", () => {
  const d = flow([{ id: "t1", kind: "assign", to: "role:intake", title: "Call back", output: { kind: "note" }, record: { expr: "event.subject" }, await: true, skills: ["phone"] }]);
  const out = round(d);
  assert.equal(out.steps[0].kind, "assign");
  assert.deepEqual([out.steps[0].record, out.steps[0].await, out.steps[0].skills], [{ expr: "event.subject" }, true, ["phone"]]);
});

test("a find step keeps one sort and opens a sort it cannot show as an advanced step", () => {
  const d = flow([{ id: "f1", kind: "find", type: "contact", limit: 5, sort: [{ field: "name", dir: "desc" }] }]);
  const draft = fromDefinition(d, options);
  assert.deepEqual([draft.steps[0].kind, draft.steps[0].sortField, draft.steps[0].sortDir], ["find", "name", "desc"]);
  assert.deepEqual(toDefinition(draft, options).steps[0].sort, [{ field: "name", dir: "desc" }]);
  const two = flow([{ id: "f1", kind: "find", type: "contact", limit: 5, sort: [{ field: "name", dir: "asc" }, { field: "id", dir: "asc" }] }]);
  assert.equal(fromDefinition(two, options).steps[0].kind, "advanced");
});

test("an extract fact keeps its description", () => {
  const d = flow([{ id: "e1", kind: "extract", input: "{message}", fields: [{ name: "amount", kind: "number", description: "The total in dollars" }] }]);
  assert.equal(round(d).steps[0].fields[0].description, "The total in dollars");
});

test("later steps can pick a group or a pulled-out fact from the value list", () => {
  const d = flow([{ id: "c1", kind: "classify", input: "{message}", labels: ["Urgent", "Routine"] }, { id: "e1", kind: "extract", input: "{message}", fields: [{ name: "amount", kind: "number" }] }, { id: "n1", kind: "formula", formula: "1" }]);
  const draft = fromDefinition(d, options);
  const found = valueSources(draft, "n1", options).map((x) => x[0]);
  for (const want of ["{steps.c1.label}", "{steps.e1.fields.amount}"]) assert.ok(found.includes(want), want);
});

test("Flow settings read from a stored Flow, write back inside the engine's ranges and drop when emptied", () => {
  const stored = { ...flow([]), description: "Welcome new contacts", concurrency: 2, lock: "trigger.after.id", stuck_after_ms: 600_000 };
  let d = fromDefinition(stored, options);
  assert.deepEqual(flowSettings(d), { description: "Welcome new contacts", concurrency: "2", lock: "trigger.after.id", stuckMinutes: "10" });
  assert.deepEqual(toDefinition(d, options).stuck_after_ms, 600_000, "an untouched setting is saved as it was");
  d = setFlowSetting(d, "concurrency", "99");
  d = setFlowSetting(d, "stuckMinutes", "5000");
  d = setFlowSetting(d, "lock", "  ");
  d = setFlowSetting(d, "description", "");
  const out = toDefinition(d, options);
  assert.equal(out.concurrency, 32);
  assert.equal(out.stuck_after_ms, 86_400_000);
  assert.ok(!("lock" in out) && !("description" in out));
  assert.deepEqual(checkFlow(out), []);
  assert.equal(setFlowSetting(d, "stuckMinutes", "0").rest.stuck_after_ms, undefined, "zero means the default");
});

test("any other module action is a step of its own that stores as the same call, and the steps with a form of their own stay theirs", () => {
  const d = { name: "Action", trigger: { kind: "created", type: "contact" }, steps: [] };
  const s = newStep("action", d, options);
  assert.notEqual(stepProblem(s, options), null, "an empty action says what to write");
  Object.assign(s, { action: "tasks.nudge", resource: "vyre://space/tasks", fields: [{ field: "taskId", value: "{after.id}" }, { field: "note", value: "Still open" }] });
  d.steps.push(s);
  assert.equal(stepProblem(s, options), null);
  const stored = toDefinition(d, options);
  assert.deepEqual(checkFlow(stored), []);
  assert.deepEqual([stored.steps[0].kind, stored.steps[0].action, stored.steps[0].resource], ["call", "tasks.nudge", "vyre://space/tasks"]);
  assert.deepEqual(stored.steps[0].input.taskId, { expr: "trigger.after.id" });
  assert.equal(stored.steps[0].input.note, "Still open", "names keep the case they were typed in");
  const back = fromDefinition(stored, options);
  assert.equal(back.steps[0].kind, "action");
  assert.deepEqual(toDefinition(back, options), stored);
  const text = fromDefinition({ ...d, steps: [{ id: "x", kind: "call", action: "comms.send", resource: "vyre://space/comms", input: { via: "carrier-pigeon" } }] }, options);
  assert.equal(text.steps[0].kind, "advanced", "a text or email call the editor cannot show stays advanced");
});

test("an ask step keeps its record and an assign step keeps how and template", () => {
  const d = flow([{ id: "q1", kind: "ask", to: "role:owner", title: "Approve?", record: { expr: "event.subject" } }, { id: "t1", kind: "assign", to: "role:intake", title: "Reply", output: { kind: "note" }, how: "tailor", template: "Dear client" }]);
  const out = round(d);
  assert.deepEqual([out.steps[0].kind, out.steps[0].record], ["ask", { expr: "event.subject" }]);
  assert.deepEqual([out.steps[1].how, out.steps[1].template], ["tailor", "Dear client"]);
  assert.deepEqual(checkFlow(out), []);
  const odd = fromDefinition(flow([{ id: "q1", kind: "ask", to: "role:owner", title: "Approve?", form: [{ name: "reason" }] }]), options);
  assert.equal(odd.steps[0].kind, "advanced", "a question with a form of its own stays as it was");
});

test("a condition can say contains and compare to yes or no, and a quoted number stays the text it was", () => {
  const trig = { kind: "created", type: "contact" };
  assert.equal(condExpr({ mode: "build", source: "trigger", field: "name", op: "contains", value: "harlow" }, trig), 'trigger.after.name contains "harlow"');
  assert.equal(condExpr({ mode: "build", source: "trigger", field: "vip", op: "==", value: "true" }, trig), "trigger.after.vip == true");
  const kept = fromDefinition(flow([{ id: "d1", kind: "decide", if: 'trigger.after.code == "007"', then: [], else: [] }]), options);
  assert.equal(kept.steps[0].cond.mode, "formula");
  assert.equal(toDefinition(kept, options).steps[0].if, 'trigger.after.code == "007"');
  const built = fromDefinition(flow([{ id: "d1", kind: "decide", if: 'trigger.after.name contains "harlow"', then: [], else: [] }]), options);
  assert.deepEqual([built.steps[0].cond.mode, built.steps[0].cond.op, built.steps[0].cond.value], ["build", "contains", "harlow"]);
});

test("a Repeat step goes through any list the engine can read, not only Find results", () => {
  const d = flow([{ id: "r1", kind: "repeat", over: "trigger.after.items", as: "item", max: 10, steps: [] }]);
  const out = round(d);
  assert.deepEqual([out.steps[0].kind, out.steps[0].over, out.steps[0].max], ["repeat", "trigger.after.items", 10]);
  assert.equal(stepProblem(fromDefinition(d, options).steps[0], options), null);
});

test("a web call keeps its query and headers and can check with HEAD", () => {
  const d = flow([{ id: "w1", kind: "service", connector: "crm", method: "HEAD", path: "/v1/ping", query: { page: "2", q: "{after.name}" }, headers: { "x-trace": "run" } }]);
  const draft = fromDefinition(d, options);
  assert.equal(draft.steps[0].kind, "web");
  assert.deepEqual(draft.steps[0].query.map((x) => x.field), ["page", "q"]);
  const out = toDefinition(draft, options);
  assert.equal(out.steps[0].method, "HEAD");
  assert.deepEqual(Object.keys(out.steps[0].query), ["page", "q"]);
  assert.deepEqual(out.steps[0].headers, { "x-trace": "run" });
  assert.equal(out.steps[0].body, undefined, "a check carries no body");
  const guarded = fromDefinition(flow([{ id: "w1", kind: "service", connector: "crm", method: "GET", path: "/", drive: { saveTo: "files/x" } }]), options);
  assert.equal(guarded.steps[0].kind, "advanced", "a drive hand-off stays as it was");
});

test("a connection's named operation is a step of its own and stores as the same service step", () => {
  const d = flow([{ id: "c1", kind: "service", connection: "crm", operation: "contacts.list", input: { limit: "5", q: "{after.name}" } }]);
  const draft = fromDefinition(d, options);
  assert.equal(draft.steps[0].kind, "connection");
  const out = toDefinition(draft, options);
  assert.deepEqual([out.steps[0].kind, out.steps[0].connection, out.steps[0].operation], ["service", "crm", "contacts.list"]);
  assert.deepEqual(Object.keys(out.steps[0].input), ["limit", "q"]);
  assert.equal(stepProblem({ id: "c1", kind: "connection", connection: "crm", operation: "Bad Op" }, options) !== null, true);
  assert.equal(fromDefinition(flow([{ id: "c1", kind: "service", connection: "crm", operation: "request", approve: "x" }]), options).steps[0].kind, "advanced");
});

test("every call a dedicated step writes is on the list the generic action step leaves alone", () => {
  const d = { name: "All", trigger: { kind: "created", type: "contact" }, steps: [] };
  for (const kind of ["sms", "email", "document", "project"]) { const s = newStep(kind, d, options); d.steps.push(s); }
  const actions = toDefinition(d, options).steps.filter((x) => x.kind === "call").map((x) => x.action);
  assert.equal(actions.length, 4, "each of the four dedicated steps writes one call");
  for (const a of actions) assert.ok(SPECIAL_ACTIONS.has(a), a);
});

test("the action picker searches by name or words and picking one fills where it acts and a row for each plain input", () => {
  const o = { ...options, actions: [{ action: "documents.generate", label: "Make a document from a template", risk: "read", inputs: { template: "string", values: "object", format: "string" } }, { action: "tasks.nudge", label: "Nudge a task", risk: "outward.send", inputs: { id: "string", days: "number" } }] };
  assert.deepEqual(actionChoices(o, "").map((x) => x[0]), ["documents.generate", "tasks.nudge"]);
  assert.deepEqual(actionChoices(o, "nudge").map((x) => x[0]), ["tasks.nudge"]);
  assert.deepEqual(actionChoices(o, "TEMPLATE").map((x) => x[0]), ["documents.generate"]);
  assert.match(actionChoices(o, "nudge")[0][1], /held for a yes/);
  assert.deepEqual(actionPick(o, "documents.generate"), { action: "documents.generate", resource: "vyre://space/documents", fields: [{ field: "template", value: "" }, { field: "format", value: "" }] });
  assert.deepEqual(actionPick(o, "gone.thing").fields, [{ field: "", value: "" }]);
});
