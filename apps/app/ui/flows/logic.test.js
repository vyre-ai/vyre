import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFlow, sourceHash } from "../../../../kernel/flows/schema.js";
import { findStep, flat, mapStep, moveDeep, canMove, addTo, removeDeep } from "./tree.js";
import { previewExpr } from "./preview.js";
import { triggerPhrase } from "./logic.js";
import { FORMULA_HASH, FORMULA_SOURCE, searchChoices, approverChoices, fromDefinition, flowSentence, toDefinition, draftProblems, newStep, removeStep, moveStep, firstStageTasks, stepSummary, stepProblem, choiceOf, valueSources, askChoices, val, dateChoices } from "./logic.js";
import { SAMPLE_OPTIONS as O, REFUND_DRAFT, ATP_DRAFT, REMINDER_DRAFT } from "../../screens/flows/starters.js";

test("the refund starter reads as one sentence", () => {
  assert.equal(flowSentence(REFUND_DRAFT, O), "When the form refund-request is submitted, create a RefundRequests record with Client, Email, Amount, Reason, then hand it to the Refunds agent with your instructions, then if amount is more than 500: 1 step, otherwise 1, then 2 more steps.");
});

test("the ATP starter says what it does", () => {
  const s = flowSentence(ATP_DRAFT, O);
  assert.match(s, /^When a person signs up, create a Client record with Name, Email/);
  assert.match(s, /start a project from the ATP playbook and link it to the new Client record/);
});

for (const d of [REFUND_DRAFT, ATP_DRAFT, REMINDER_DRAFT]) {
  test(`${d.name} is a Flow the box accepts`, () => {
    assert.deepEqual(draftProblems(d, O), []);
    const r = checkFlow(toDefinition(d));
    assert.deepEqual(r, [], JSON.stringify(r));
  });
}

test("every step kind of the palette stores as a valid step", () => {
  const d = { name: "All kinds", trigger: { kind: "stage", type: "matter", stage: "Drafting" }, steps: [] };
  for (const kind of ["create", "project", "agent", "assign", "email", "ask", "update"]) {
    const s = newStep(kind, d, O);
    Object.assign(s, { type: s.type || "matter", instructions: "x", title: "t", to: s.kind === "email" ? "a@b.co" : s.to, body: "b", field: "status", value: "Open", agent: "refunds" });
    d.steps.push(s);
  }
  const r = checkFlow(toDefinition(d));
  assert.deepEqual(r, [], JSON.stringify(r));
});

test("problems say what is missing in words", () => {
  const d = { name: "", trigger: { kind: "created" }, steps: [{ id: "agent1", kind: "agent", agent: "refunds", record: "trigger", instructions: "" }] };
  assert.deepEqual(draftProblems(d, O), ["Give the Flow a name.", "Choose the object that starts it.", "Step 1: Tell the agent what to do with it."]);
});

test("removing a step repoints what used it, moving swaps neighbours", () => {
  const steps = removeStep(ATP_DRAFT.steps, "create1");
  assert.equal(steps.find((s) => s.id === "project2").link, "trigger");
  assert.deepEqual(moveStep([1, 2, 3], 0, 1), [2, 1, 3]);
  assert.deepEqual(moveStep([1, 2, 3], 0, -1), [1, 2, 3]);
});

test("a project step shows what its first stage hands out", () => {
  const t = firstStageTasks(O.templates[0], O);
  assert.equal(t.stage, "Kickoff");
  assert.deepEqual(t.tasks.map((x) => x.who), ["the project lead", "the Paralegal team", "the Research agent"]);
  assert.equal(stepSummary({ id: "p", kind: "project", template: "tpl_atp" }, O), "Start a project from the ATP playbook");
});

test("a stored Flow opens as a draft and saves back the same", () => {
  for (const d of [REFUND_DRAFT, ATP_DRAFT, REMINDER_DRAFT]) {
    const stored = toDefinition(d);
    const back = fromDefinition(stored);
    assert.equal(back.steps.some((s) => s.kind === "advanced"), false, "every step the palette wrote is understood");
    assert.deepEqual(toDefinition(back), stored);
  }
});

test("a step the palette cannot say is kept as it was", () => {
  const stored = { ...toDefinition(REFUND_DRAFT), concurrency: 2, steps: [...toDefinition(REFUND_DRAFT).steps, { id: "look", kind: "classify", input: { expr: "trigger.a + trigger.b" }, labels: ["x", "y"] }] };
  const d = fromDefinition(stored);
  assert.equal(d.steps.at(-1).kind, "advanced");
  assert.equal(stepSummary(d.steps.at(-1), O), "Advanced step (classify)");
  assert.deepEqual(toDefinition(d), stored);
});

test("a stored group rides along", () => {
  const d = fromDefinition({ ...toDefinition(REFUND_DRAFT), group: "Money" });
  assert.equal(d.group, "Money");
  assert.equal(toDefinition(d).group, "Money");
});

test("a record trigger is the type's own event, and a step reads the record from the event", () => {
  const d = { name: "On refund", trigger: { kind: "created", type: "refund_requests" }, steps: [{ id: "agent1", kind: "agent", agent: "refunds", title: "t", instructions: "x", record: "trigger" }] };
  const def = toDefinition(d);
  assert.deepEqual(def.trigger, { on: "event", event: "refund_requests.created" });
  assert.deepEqual(def.steps[0].record, { expr: "event.subject" });
  assert.deepEqual(checkFlow(def), []);
  assert.deepEqual(toDefinition(fromDefinition(def)), def);
});

test("braces take a value from what started the Flow and come back as braces", () => {
  const d = { name: "Mail", trigger: { kind: "signup" }, steps: [{ id: "email1", kind: "email", to: "{email}", subject: "Hello", body: "Hi {name}" }] };
  const def = toDefinition(d);
  assert.deepEqual(def.steps[0].input.to, { expr: "trigger.email" });
  assert.deepEqual(def.steps[0].input.body, { expr: '"Hi " + text(trigger.name)' }, "braces inside text are filled in when the step runs");
  assert.equal(fromDefinition(def).steps[0].body, "Hi {name}");
  assert.equal(fromDefinition(def).steps[0].to, "{email}");
});

test("an approver, followers and their notes round-trip, and an agent may approve", () => {
  const d = { name: "People", trigger: { kind: "manual" }, steps: [{ id: "assign1", kind: "assign", to: "role:attorney", title: "Review", brief: "Look at [[record:this]]", checker: "role:manager", followers: ["person:ana", "agent:research"], approverNote: "Check the sums", followerNote: "FYI" }] };
  const def = toDefinition(d);
  assert.deepEqual(def.steps[0].followers, ["person:ana", "teammate:research"]);
  assert.deepEqual(def.steps[0].notes, { approver: "Check the sums", followers: "FYI" });
  assert.deepEqual(checkFlow(def), []);
  assert.deepEqual(toDefinition(fromDefinition(def)), def);
  assert.match(stepSummary(d.steps[0], O), /checked by the Manager team, followed by 2 others/);
  assert.equal(approverChoices(O).some(([v]) => v.startsWith("agent:")), true);
  const lowly = { ...O, agents: [{ name: "x", label: "X" }, { name: "y", label: "Y", staff: false }] };
  assert.equal(approverChoices(lowly).some(([v]) => v.startsWith("agent:")), false, "an agent not made by an owner or admin is not offered");
});

test("an agent as the approver is stored as a teammate checker and comes back", () => {
  const d = { name: "Review", trigger: { kind: "manual" }, steps: [{ id: "assign1", kind: "assign", to: "agent:intake", title: "Draft", checker: "agent:research" }] };
  const def = toDefinition(d);
  assert.equal(def.steps[0].checker, "teammate:research");
  assert.deepEqual(checkFlow(def), []);
  assert.deepEqual(toDefinition(fromDefinition(def)), def);
});

test("If / else, For each and Side by side are real branches that store as the engine's own steps", () => {
  const d = { name: "Branches", trigger: { kind: "form", path: "refund" }, steps: [
    { id: "find1", kind: "find", type: "client" },
    { id: "decide2", kind: "decide", cond: { mode: "build", source: "trigger", field: "amount", op: ">", value: "500" },
      then: [{ id: "ask3", kind: "ask", to: "role:attorney", title: "Approve this refund" }],
      else: [{ id: "assign4", kind: "assign", to: "role:attorney", title: "Pay it" }] },
    { id: "repeat5", kind: "repeat", over: "steps.find1.rows", as: "row", steps: [{ id: "email6", kind: "email", to: "a@b.co", subject: "Hi", body: "Hello" }] },
    { id: "parallel7", kind: "parallel", lanes: [{ steps: [{ id: "assign8", kind: "assign", to: "role:attorney", title: "One" }] }, { steps: [{ id: "assign9", kind: "assign", to: "role:attorney", title: "Two" }] }] },
  ] };
  const def = toDefinition(d);
  assert.equal(def.steps[1].if, "trigger.amount > 500");
  assert.equal(def.steps[3].steps[0].kind, "branch");
  assert.deepEqual(checkFlow(def), []);
  assert.deepEqual(toDefinition(fromDefinition(def)), def);
  assert.match(stepSummary(d.steps[1], O, d), /^If amount is more than 500: 1 step, otherwise 1$/);
});

test("steps are found, changed, moved and removed at any depth", () => {
  const steps = [{ id: "a", kind: "create" }, { id: "d", kind: "decide", then: [{ id: "t1", kind: "ask", record: "a" }, { id: "t2", kind: "ask" }], else: [] }];
  assert.equal(findStep(steps, "t2").id, "t2");
  assert.deepEqual(flat(steps).map((s) => s.id), ["a", "d", "t1", "t2"]);
  const edited = mapStep(steps, "t1", (s) => ({ ...s, title: "x" }));
  assert.equal(edited[1].then[0].title, "x");
  assert.deepEqual(moveDeep(steps, "t2", -1)[1].then.map((s) => s.id), ["t2", "t1"]);
  assert.deepEqual(canMove(steps, "t1"), { up: false, down: true });
  assert.deepEqual(addTo(steps, { parent: "d", key: "else" }, { id: "e1", kind: "ask" })[1].else.map((s) => s.id), ["e1"]);
  const gone = removeDeep(steps, "a");
  assert.equal(gone[0].id, "d");
  assert.equal(gone[0].then[0].record, "trigger", "what pointed at the removed step points at what started the Flow");
});

test("every other step kind the engine has stores, checks and comes back", () => {
  const d = { name: "Everything", trigger: { kind: "form", path: "intake" }, steps: [
    { id: "find1", kind: "find", type: "client", where: "record.email == trigger.email", limit: 5 },
    { id: "upsert2", kind: "upsert", type: "client", matchFields: [{ field: "Email", value: "{email}" }], fields: [{ field: "Name", value: "{name}" }] },
    { id: "stage3", kind: "stage", type: "client", record: "upsert2", to: "Active" },
    { id: "remove4", kind: "remove", type: "client", record: "upsert2" },
    { id: "wait5", kind: "wait", amount: 2, unit: "days" },
    { id: "formula6", kind: "formula", formula: "round(trigger.amount * 1.2)" },
    { id: "sms7", kind: "sms", to: "{phone}", body: "Hello" },
    { id: "classify8", kind: "classify", input: "{message}", labels: "Urgent, Routine" },
    { id: "extract9", kind: "extract", input: "{message}", fields: [{ name: "Amount", kind: "number" }] },
    { id: "subflow10", kind: "subflow", flow: "send_welcome", fields: [{ field: "Client", value: "{name}" }] },
  ] };
  const def = toDefinition(d);
  assert.equal(def.steps[4].for_ms, 2 * 86_400_000);
  assert.deepEqual(checkFlow(def), []);
  assert.deepEqual(toDefinition(fromDefinition(def)), def);
  assert.equal(flat(fromDefinition(def).steps).some((s) => s.kind === "advanced"), false);
});

test("Find or create a record: match, create-only fields and optional update compile to an upsert and come back", () => {
  const step = { id: "upsert1", kind: "upsert", type: "client", matchFields: [{ field: "email", value: "{email}" }], fields: [{ field: "name", value: "{name}" }], updateFields: [{ field: "plan", value: "Gold" }] };
  const d = { name: "Find", trigger: { kind: "form", path: "intake" }, steps: [step, { id: "email2", kind: "email", to: "{steps.upsert1.record.data.email}", subject: "Hi", body: "Hello" }] };
  const def = toDefinition(d);
  assert.deepEqual(def.steps[0], { id: "upsert1", kind: "upsert", type: "client", match: { email: { expr: "trigger.email" } }, set: { name: { expr: "trigger.name" } }, update: { plan: "Gold" } });
  assert.deepEqual(checkFlow(def), []);
  assert.deepEqual(fromDefinition(def).steps[0], step);
  assert.deepEqual(toDefinition(fromDefinition(def)), def);
});

test("Find or create with no update fields leaves a found record alone; an older upsert keeps changing it", () => {
  const mk = (extra) => toDefinition({ name: "F", trigger: { kind: "manual" }, steps: [{ id: "upsert1", kind: "upsert", type: "client", matchFields: [{ field: "Email", value: "a@b.co" }], fields: [{ field: "Name", value: "Ann" }], ...extra }] }).steps[0];
  assert.deepEqual(mk({ updateFields: [] }).update, {}, "an empty update is stored, so a found record is not touched");
  assert.equal("update" in mk({}), false, "no update key is the older meaning: set applies to a found record too");
  const back = fromDefinition({ format: 1, name: "f", trigger: { on: "manual" }, steps: [mk({ updateFields: [] })] }).steps[0];
  assert.deepEqual(back.updateFields, []);
  assert.equal(fromDefinition({ format: 1, name: "f", trigger: { on: "manual" }, steps: [mk({})] }).steps[0].updateFields, undefined);
  assert.equal(stepProblem({ id: "u", kind: "upsert", type: "client", matchFields: [{ field: "", value: "" }], fields: [], updateFields: [] }, { types: [] }), "Say which field finds an existing record.");
});

test("Find or create is in the palette and later steps can read what it found or made", () => {
  assert.equal(choiceOf("upsert").label, "Find or create a record");
  const o = { types: [{ name: "client", label: "Client", fields: [{ name: "email", label: "Email" }] }], agents: [], templates: [], roles: [], people: [] };
  const d = { name: "F", trigger: { kind: "manual" }, steps: [{ id: "upsert1", kind: "upsert", type: "client", matchFields: [], fields: [] }, { id: "email2", kind: "email", to: "", subject: "", body: "" }] };
  const tokens = valueSources(d, "email2", o).map(([t]) => t);
  assert.ok(tokens.includes("{steps.upsert1.record.id}") && tokens.includes("{steps.upsert1.created}") && tokens.includes("{steps.upsert1.record.data.email}"));
});

test("the formula step is a Code step with a fixed source whose hash is the engine's", () => {
  assert.equal(FORMULA_HASH, sourceHash(FORMULA_SOURCE));
});

test("the palette is grouped and searchable", () => {
  assert.deepEqual(searchChoices("").map((g) => g.name), ["Logic", "Records", "Calculate", "Send", "Web", "AI", "Work"]);
  assert.deepEqual(searchChoices("else").flatMap((g) => g.items.map((i) => i.kind)), ["decide"]);
  assert.deepEqual(searchChoices("sms").flatMap((g) => g.items.map((i) => i.kind)), ["sms"]);
  assert.deepEqual(searchChoices("zzzz"), []);
});

test("a formula previews on sample data with the engine's own language", () => {
  assert.deepEqual(previewExpr("round(trigger.amount * 1.2)"), { ok: true, value: 144, text: "144" });
  assert.equal(previewExpr("trigger.amount > 500").value, false);
  assert.equal(previewExpr("upper(trigger.name)").text, JSON.stringify("PAT LOPEZ"));
  assert.equal(previewExpr("nope(1)").ok, false);
  assert.equal(previewExpr("").ok, false);
});

test("Send with picks the sending service, and the Web step names a vault connection", () => {
  const d = { name: "Send", trigger: { kind: "signup" }, steps: [
    { id: "email1", kind: "email", sendStep: "comms.email", sendWith: "v1", to: "{email}", subject: "Hi", body: "Hello" },
    { id: "web2", kind: "web", connector: "crm_api", method: "POST", path: "/v1/customers", body: "{name}" },
    { id: "web3", kind: "web", connector: "crm_api", method: "GET", path: "/v1/ping", body: "" },
  ] };
  const def = toDefinition(d);
  assert.equal(def.steps[0].action, "comms.email");
  assert.deepEqual(def.steps[0].input, { to: { expr: "trigger.email" }, subject: "Hi", body: "Hello" });
  assert.equal(def.steps[1].kind, "service");
  assert.equal(def.steps[2].body, undefined);
  assert.deepEqual(checkFlow(def), []);
  const back = fromDefinition(def);
  assert.equal(back.steps[0].sendStep, "comms.email");
  assert.deepEqual(toDefinition(back), def);
});

test("a step checked by an agent says so in words, not a person", () => {
  assert.match(stepSummary({ id: "a", kind: "assign", to: "role:attorney", title: "Draft", checker: "agent:research" }, O), /checked by the Research agent, not a person/);
});

test("a wait can go until a date: before, after or at, and it comes back the same", () => {
  assert.equal(stepSummary(REMINDER_DRAFT.steps[0], O, REMINDER_DRAFT), "Wait until 1 day before {Appointment time}");
  assert.equal(stepSummary(REMINDER_DRAFT.steps[2], O, REMINDER_DRAFT), "Wait until 2 hours before {Appointment time}");
  assert.equal(stepSummary(REMINDER_DRAFT.steps[1], O, REMINDER_DRAFT), "Text {Phone}");
  assert.equal(stepSummary({ id: "s", kind: "sms", to: "{phone}", body: "x" }, O, { name: "f", trigger: { kind: "form", path: "p" }, steps: [] }), "Text the number from the form");
  const w = toDefinition(REMINDER_DRAFT).steps;
  assert.deepEqual(w[0], { id: "wait1", kind: "wait", until: { expr: "trigger.after.starts_at" }, offset_ms: -86_400_000 });
  assert.equal(w[2].offset_ms, -7_200_000);
  const mk = (when, amount, unit) => ({ name: "x", trigger: REMINDER_DRAFT.trigger, steps: [{ id: "w", kind: "wait", mode: "until", field: "{after.starts_at}", when, amount, unit }] });
  assert.equal(toDefinition(mk("after", 3, "hours")).steps[0].offset_ms, 3 * 3_600_000);
  assert.equal("offset_ms" in toDefinition(mk("at", 1, "hours")).steps[0], false);
  for (const d of [mk("before", 90, "minutes"), mk("after", 2, "days"), mk("at", 1, "hours")]) {
    const def = toDefinition(d);
    assert.deepEqual(checkFlow({ format: 1, name: "t", authorship: "human", trigger: { on: "event", event: "appointment.created" }, ...def }), []);
    const back = fromDefinition(def);
    assert.equal(back.steps[0].kind, "wait");
    assert.deepEqual(toDefinition(back), def);
  }
  assert.equal(draftProblems(mk("before", 1, "days"), O).length, 0);
  assert.ok(draftProblems({ ...mk("before", 1, "days"), steps: [{ id: "w", kind: "wait", mode: "until", field: "", when: "before", amount: 1, unit: "days" }] }, O).length > 0);
  assert.equal(newStep("wait", REMINDER_DRAFT, O).mode, "for");
});

test("A record is created or updated: stored as two events with the field filter and what a second change does, and read back the same", () => {
  const d = { name: "Remind", trigger: { kind: "changed", type: "appointment", field: "starts_at", again: "replace" }, steps: [{ id: "w", kind: "wait", amount: 1, unit: "hours" }] };
  const def = toDefinition(d);
  assert.deepEqual(def.trigger, { on: "event", event: ["appointment.created", "appointment.updated"], field: "starts_at", when_record_changes: "replace" });
  assert.deepEqual(checkFlow(def).filter((p) => /trigger/.test(p.path || "")), []);
  assert.deepEqual(fromDefinition(def).trigger, d.trigger);
  assert.equal(flowSentence(d, O).split(",")[0], "When a record in the Appointment object is created or updated");
  assert.deepEqual(fromDefinition({ ...def, trigger: { ...def.trigger, when_record_changes: "keep" } }).trigger.again, "keep");
});

test("the Appointment reminder starter starts on created or updated, only when the time changes, and starts over", () => {
  assert.deepEqual(REMINDER_DRAFT.trigger, { kind: "changed", type: "appointment", field: "starts_at", again: "replace" });
  assert.equal(toDefinition(REMINDER_DRAFT).trigger.when_record_changes, "replace");
});

test("text with tokens becomes one joined expression and reads back as the same text", async () => {
  assert.deepEqual(val("Hello {after.client}, call {steps.find1.rows}."), { expr: '"Hello " + text(trigger.after.client) + ", call " + text(steps.find1.rows) + "."' });
  assert.equal(val("no tokens"), "no tokens");
  assert.equal(val('say "hi" {name}\nbye').expr, '"say \\"hi\\" " + text(trigger.name) + "\\nbye"');
  assert.equal(val("a\r\nb {x}\u0001c").expr, '"a\\nb " + text(trigger.x) + "c"', "CRLF becomes one newline and control characters are dropped");
  for (const t of ["Hello {name}, ok", "{name} is here", 'a "quoted" {x} line\nbreak {steps.a.created}']) {
    const def = toDefinition({ name: "T", trigger: { kind: "form", path: "f" }, steps: [{ id: "sms1", kind: "sms", to: "+15550100", body: t }] });
    assert.deepEqual(checkFlow(def), []);
    assert.equal(fromDefinition(def).steps[0].body, t);
  }
});

test("Update takes a value from the Flow like any other step", () => {
  const d = { name: "U", trigger: { kind: "created", type: "client" }, steps: [{ id: "update1", kind: "update", type: "client", record: "trigger", field: "Note", value: "Hi {after.name}" }, { id: "update2", kind: "update", type: "client", record: "trigger", field: "Email", value: "{after.email}" }] };
  const def = toDefinition(d);
  assert.deepEqual(def.steps[0].set, { note: { expr: '"Hi " + text(trigger.after.name)' } });
  assert.deepEqual(def.steps[1].set, { email: { expr: "trigger.after.email" } });
  assert.deepEqual(checkFlow(def), []);
  const back = fromDefinition(def);
  assert.equal(back.steps[0].value, "Hi {after.name}");
  assert.equal(back.steps[1].value, "{after.email}");
});

test("a question goes to a person or a role, never an agent", () => {
  assert.ok(askChoices(O).length > 0 && askChoices(O).every(([v]) => !v.startsWith("agent:")));
  assert.match(stepProblem({ id: "ask1", kind: "ask", to: "agent:refunds", title: "Ok?" }, O), /person or a team or role/);
  assert.equal(stepProblem({ id: "ask1", kind: "ask", to: "role:manager", title: "Ok?" }, O), null);
});

test("a date or time field inside text is written as people read it, and {now} and {today} are helpers", () => {
  const o = { types: [{ name: "appointment", label: "Appointment", fields: [{ name: "starts_at", label: "Starts", kind: "datetime" }, { name: "due", label: "Due", kind: "date" }, { name: "fee", label: "Fee", kind: "number" }] }], agents: [], templates: [], roles: [], people: [] };
  const body = "At {after.starts_at}, due {after.due}, fee {after.fee}, sent {today} {now}.";
  const d = { name: "R", trigger: { kind: "created", type: "appointment" }, steps: [{ id: "sms1", kind: "sms", to: "+15550100", body }, { id: "wait2", kind: "wait", mode: "until", field: "{after.starts_at}", when: "before", amount: 1, unit: "hours" }] };
  const def = toDefinition(d, o);
  assert.equal(def.steps[0].input.body.expr, '"At " + datetime(trigger.after.starts_at, tz) + ", due " + date(trigger.after.due) + ", fee " + text(trigger.after.fee) + ", sent " + date(now, tz) + " " + datetime(now, tz) + "."');
  assert.deepEqual(def.steps[1].until, { expr: "trigger.after.starts_at" }, "a whole value stays the raw time, for a wait");
  assert.deepEqual(checkFlow(def), []);
  assert.equal(fromDefinition(def).steps[0].body, body);
  assert.equal(toDefinition(d).steps[0].input.body.expr.includes("datetime(trigger"), false, "without the object's fields a date is plain text");
  assert.deepEqual(val("{today}"), { expr: "date(now, tz)" });
  assert.deepEqual(dateChoices(d, "wait2", o).map(([t]) => t).filter((t) => t === "{now}" || t === "{today}"), [], "a wait cannot wait for the helpers");
});

test("a time in text can be moved by an amount and printed in a named format", () => {
  const o = { types: [{ name: "appointment", label: "Appointment", fields: [{ name: "starts_at", label: "Starts", kind: "datetime" }, { name: "due", label: "Due", kind: "date" }] }], agents: [], templates: [], roles: [], people: [] };
  const d = (body) => ({ name: "R", trigger: { kind: "created", type: "appointment" }, steps: [{ id: "sms1", kind: "sms", to: "+15550100", body }] });
  const expr = (body) => toDefinition(d(body), o).steps[0].input.body.expr;
  assert.equal(expr("See you {after.starts_at - 1 day}"), '"See you " + format(trigger.after.starts_at, "weekdaytime", tz, -1, "day")');
  assert.equal(expr("{after.starts_at + 2 hours as time}"), 'format(trigger.after.starts_at, "time", tz, 2, "hours")');
  assert.equal(expr("Due {after.due + 1 month}"), '"Due " + format(trigger.after.due, "weekday", "UTC", 1, "month")', "a date-only field has no zone");
  assert.equal(expr("Sent {now - 30 minutes as time}"), '"Sent " + format(now, "time", tz, -30, "minutes")');
  assert.equal(expr("At {after.starts_at as iso}"), '"At " + format(trigger.after.starts_at, "iso", tz)');
  for (const body of ["See you {after.starts_at - 1 day}", "{after.starts_at + 2 hours as time}", "Due {after.due + 1 month}", "At {after.starts_at as iso}", "Sent {now - 30 minutes as time} on {today}"]) {
    const def = toDefinition(d(body), o);
    assert.deepEqual(checkFlow(def), []);
    assert.equal(fromDefinition(def).steps[0].body, body, body);
  }
});

test("an agent's task and instructions, a task title and a question are templates like every other text", () => {
  const d = { name: "T", trigger: { kind: "created", type: "client" }, steps: [
    { id: "agent1", kind: "agent", agent: "refunds", title: "Refund for {after.name}", instructions: "Look at [[record:this]]. Greet {after.name} and mention {after.plan}.", record: "trigger" },
    { id: "assign2", kind: "assign", to: "role:attorney", title: "Call {after.name}" },
    { id: "ask3", kind: "ask", to: "role:attorney", title: "Approve {after.name}?" },
  ] };
  const def = toDefinition(d);
  assert.deepEqual(def.steps[0].instructions, { expr: '"Look at [[record:this]]. Greet " + text(trigger.after.name) + " and mention " + text(trigger.after.plan) + "."' });
  assert.deepEqual(def.steps[0].title, { expr: '"Refund for " + text(trigger.after.name)' });
  assert.deepEqual(def.steps[1].title, { expr: '"Call " + text(trigger.after.name)' });
  assert.deepEqual(def.steps[2].title, { expr: '"Approve " + text(trigger.after.name) + "?"' });
  assert.deepEqual(checkFlow(def), []);
  const back = fromDefinition(def);
  assert.equal(back.steps[0].instructions, d.steps[0].instructions);
  assert.equal(back.steps[0].title, d.steps[0].title);
  assert.equal(back.steps[1].title, d.steps[1].title);
  assert.equal(back.steps[2].title, d.steps[2].title);
  assert.equal(flat(back.steps).some((s) => s.kind === "advanced"), false);
  assert.equal(toDefinition({ ...d, steps: [{ ...d.steps[0], instructions: "Plain words.", title: "" }] }).steps[0].instructions, "Plain words.", "text with no braces stays text");
});

test("an emails field is its main address: in text, and as the To, Reply-To or From of a send", () => {
  const o = { types: [{ name: "client", label: "Client", fields: [{ name: "email", label: "Email", kind: "emails" }, { name: "phone", label: "Phone", kind: "phones" }, { name: "name", label: "Name", kind: "text" }] }], agents: [], templates: [], roles: [], people: [] };
  const d = { name: "E", trigger: { kind: "created", type: "client" }, steps: [
    { id: "email1", kind: "email", sendStep: "comms.email", to: "{after.email}", subject: "Hi", body: "We have {after.email} and {after.phone} for {after.name}.", replyTo: "{after.email}" },
    { id: "sms2", kind: "sms", to: "{after.phone}", body: "Hello" },
  ] };
  const def = toDefinition(d, o);
  assert.deepEqual(def.steps[0].input.to, { expr: "first(trigger.after.email)" });
  assert.deepEqual(def.steps[0].input.replyTo, { expr: "first(trigger.after.email)" });
  assert.deepEqual(def.steps[0].input.body, { expr: '"We have " + first(trigger.after.email) + " and " + first(trigger.after.phone) + " for " + text(trigger.after.name) + "."' });
  assert.deepEqual(def.steps[1].input.to, { expr: "first(trigger.after.phone)" });
  assert.deepEqual(checkFlow(def), []);
  const back = fromDefinition(def);
  assert.equal(back.steps[0].to, "{after.email}");
  assert.equal(back.steps[0].replyTo, "{after.email}");
  assert.equal(back.steps[0].body, d.steps[0].body);
  assert.equal(back.steps[1].to, "{after.phone}");
  assert.deepEqual(toDefinition(d).steps[0].input.to, { expr: "trigger.after.email" }, "without the object's fields the value is as it is");
});

test("the triggers the engine has are in the builder: removed, a module event, a watcher, and schedules with a time", () => {
  const cases = [
    [{ kind: "removed", type: "client" }, { on: "event", event: "client.removed" }],
    [{ kind: "event", event: "documents.signed" }, { on: "event", event: "documents.signed" }],
    [{ kind: "watcher", watcher: "new-mail" }, { on: "watcher", watcher: "new-mail" }],
    [{ kind: "schedule", every: "Every 15 minutes" }, { on: "time", every_ms: 900000 }],
    [{ kind: "schedule", every: "Every hour" }, { on: "time", cron: "0 * * * *" }],
    [{ kind: "schedule", every: "Every day", at: "09:00" }, { on: "time", cron: "0 9 * * *" }],
    [{ kind: "schedule", every: "Every weekday", at: "17:30" }, { on: "time", cron: "30 17 * * 1-5" }],
    [{ kind: "schedule", every: "Every Monday", at: "08:05" }, { on: "time", cron: "5 8 * * 1" }],
    [{ kind: "schedule", every: "Every month", at: "06:00" }, { on: "time", cron: "0 6 1 * *" }],
  ];
  for (const [trigger, stored] of cases) {
    const def = toDefinition({ name: "T", trigger, steps: [{ id: "wait1", kind: "wait", amount: 1, unit: "days" }] });
    assert.deepEqual(def.trigger, stored);
    assert.deepEqual(checkFlow(def), [], JSON.stringify(stored));
    assert.deepEqual(fromDefinition(def).trigger, trigger);
  }
  assert.deepEqual(fromDefinition({ format: 1, name: "t", trigger: { on: "time", cron: "0 9 * * *" }, steps: [] }).trigger, { kind: "schedule", every: "Every day", at: "09:00" }, "an older daily Flow keeps its time");
  assert.equal(fromDefinition({ format: 1, name: "t", trigger: { on: "time", cron: "0 9 15 * *" }, steps: [] }).trigger.kind, "advanced", "a schedule the builder cannot say is kept as it is");
  assert.equal(triggerPhrase({ kind: "schedule", every: "Every weekday", at: "17:30" }, O), "it is every weekday at 17:30");
  assert.equal(triggerPhrase({ kind: "event", event: "documents.signed" }, O), "a document is signed");
  assert.ok(draftProblems({ name: "T", trigger: { kind: "schedule", every: "Every day", at: "9am" }, steps: [{ id: "wait1", kind: "wait", amount: 1, unit: "days" }] }, O).some((p) => /like 09:00/.test(p)));
  assert.ok(draftProblems({ name: "T", trigger: { kind: "watcher", watcher: "" }, steps: [{ id: "wait1", kind: "wait", amount: 1, unit: "days" }] }, O).includes("Name the watcher."));
});

test("Look up one record and Keep only some of a list are in the palette and round-trip", () => {
  assert.equal(choiceOf("pick").label, "Look up one record");
  assert.equal(choiceOf("filter").label, "Keep only some of a list");
  const o = { types: [{ name: "client", label: "Client", fields: [{ name: "email", label: "Email" }] }], agents: [], templates: [], roles: [], people: [] };
  const d = { name: "P", trigger: { kind: "form", path: "f" }, steps: [
    { id: "find1", kind: "find", type: "client", where: "", limit: 20 },
    { id: "filter2", kind: "filter", from: "steps.find1.rows", where: 'record.email == "a@b.co"' },
    { id: "pick3", kind: "pick", type: "client", where: "record.email == trigger.email" },
    { id: "update4", kind: "update", type: "client", record: "pick3", field: "Note", value: "Hi" },
  ] };
  const def = toDefinition(d);
  assert.deepEqual(def.steps[1], { id: "filter2", kind: "filter", from: "steps.find1.rows", where: 'record.email == "a@b.co"' });
  assert.deepEqual(def.steps[2], { id: "pick3", kind: "pick", type: "client", where: "record.email == trigger.email" });
  assert.deepEqual(def.steps[3].record, { expr: "steps.pick3.record.id" });
  assert.deepEqual(checkFlow(def), []);
  assert.deepEqual(toDefinition(fromDefinition(def)), def);
  assert.equal(flat(fromDefinition(def).steps).some((s) => s.kind === "advanced"), false);
  const tokens = valueSources(d, "update4", o).map(([t]) => t);
  assert.ok(tokens.includes("{steps.filter2.rows}") && tokens.includes("{steps.pick3.found}") && tokens.includes("{steps.pick3.record.data.email}"));
  assert.equal(stepProblem({ id: "filter2", kind: "filter", from: "", where: "" }, o), "Choose the list to narrow. Add a Find records step first.");
  assert.equal(newStep("filter", { ...d, steps: d.steps.slice(0, 1) }, o).from, "steps.find1.rows");
});

test("cc and bcc on an email step are saved in the definition and read back, on both ways of sending", () => {
  for (const sendStep of [undefined, "comms.email"]) {
    const d = { name: "Mail", trigger: { kind: "signup" }, steps: [{ id: "email1", kind: "email", ...(sendStep ? { sendStep } : {}), to: "{email}", cc: "ops@harlow.example", bcc: "{owner}", subject: "Hello", body: "Hi" }] };
    const def = toDefinition(d);
    assert.ok(def.steps[0].input.cc && def.steps[0].input.bcc, "both are in the step's input");
    const back = fromDefinition(def).steps[0];
    assert.equal(back.cc, "ops@harlow.example"); assert.equal(back.bcc, "{owner}"); assert.equal(back.kind, "email");
  }
  const none = toDefinition({ name: "Mail", trigger: { kind: "signup" }, steps: [{ id: "email1", kind: "email", to: "a@b.co", subject: "s", body: "b" }] });
  assert.equal("cc" in none.steps[0].input, false, "left out when empty");
});
