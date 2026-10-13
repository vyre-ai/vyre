// @ts-check
// The Engineer handoff: the card says where the request came from and what the thing is now, the message carries it as words and as structured context, and the reads use the person's own access.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { INTENTS, agentShape, contextCard, flowShape, handoffText, intentOf, objectShape, openRefusal, playbookShape, queueHandoff, takeHandoff } from "./model.js";
import { readShape } from "./source.js";

const PLAYBOOK = { template: "t1", name: "Estate intake", state: "draft", body: { name: "Estate intake", noun: { one: "matter", many: "matters" }, stages: [{ name: "Intake", tasks: [{ title: "Collect ID" }, { title: "Conflict check" }] }, { name: "Drafting", tasks: [] }] } };

test("intent: a named thing is changed, none is new, an explicit intent wins", () => {
  assert.equal(intentOf({ source: "playbook" }), "create");
  assert.equal(intentOf({ source: "playbook", ref: "t1" }), "change");
  assert.equal(intentOf({ source: "playbook", ref: "t1", intent: "explain" }), "explain");
  assert.equal(intentOf({ source: "flow", intent: /** @type {any} */ ("odd") }), "create");
  assert.ok(Object.keys(INTENTS).length === 3);
});

test("a playbook is read as its name, noun, stages and tasks, compactly", () => {
  const s = playbookShape(PLAYBOOK);
  assert.deepEqual(s.slice(0, 3), ["Estate intake", "Its projects are called matters.", "State: draft."]);
  assert.ok(s.includes("1. Intake: Collect ID; Conflict check"));
  assert.ok(s.includes("2. Drafting (no tasks yet)"));
  const big = playbookShape({ body: { name: "Big", stages: Array.from({ length: 14 }, (_, i) => ({ name: `S${i}`, tasks: [] })) } });
  assert.equal(big.filter((l) => /^\d+\./.test(l)).length, 10);
  assert.ok(big.includes("… and 4 more"));
  assert.deepEqual(playbookShape({ body: { name: "Empty" } }), ["Empty", "No stages yet."]);
});

test("objects, flows and agents are read in a few lines; an agent never shows more than its list says", () => {
  assert.deepEqual(objectShape({ plural: "Clients", fields: [{ label: "Phone", kind: "phone" }, { name: "SSN" }] }), ["Clients", "Phone (phone)", "SSN (text)"]);
  assert.deepEqual(flowShape({ name: "Intake nudge", status: "live", trigger: "A new client", steps: ["Send email", "Wait 2 days"] }), ["Intake nudge", "State: live.", "Starts: A new client", "1. Send email", "2. Wait 2 days"]);
  assert.deepEqual(agentShape({ name: "kit", kind: "assistant", model: "sonnet", projects: "*", computer: true, secret: "x" }), ["kit", "Kind: assistant.", "Model: sonnet.", "Works on every project.", "Has a computer."]);
  assert.ok(agentShape({ name: "a", projects: ["p1"] }).includes("Works on 1 project."));
});

test("the message names where it came from, what it is now, what was asked, and carries the structured context", () => {
  const card = contextCard({ source: "playbook", ref: "t1", words: "add a conflict check stage" }, { name: "Estate intake", shape: playbookShape(PLAYBOOK) });
  const t = handoffText(card);
  assert.ok(t.startsWith("From Playbooks: Estate intake (change this one)"));
  assert.ok(t.includes("What it is now:\n- Estate intake"));
  assert.ok(t.includes("What I want: add a conflict check stage"));
  assert.ok(t.includes("the two or three questions that matter most"));
  const json = JSON.parse(/```engineer-context\n([\s\S]*)\n```/.exec(t)?.[1] ?? "{}");
  assert.deepEqual([json.source, json.ref, json.intent, json.words], ["playbook", "t1", "change", "add a conflict check stage"]);
  assert.ok(json.shape.length > 3);
});

test("a new one has no shape and says so; with no words it still asks for something", () => {
  const t = handoffText(contextCard({ source: "flow" }));
  assert.ok(t.startsWith("From Flows (make a new one)"));
  assert.ok(t.includes("There is no Flow yet: this one is new."));
  assert.ok(t.includes("What I want: Help me make a new Flow."));
});

test("a handoff waits once: taking it clears it", () => {
  assert.equal(takeHandoff(), null);
  queueHandoff({ source: "agent", ref: "kit" });
  assert.deepEqual(takeHandoff(), { source: "agent", ref: "kit" });
  assert.equal(takeHandoff(), null);
});

test("shapes are read as the person: each read is one box call, and a read that is refused gives no shape", async () => {
  /** @type {string[]} */ const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push(`${tool}:${input.template ?? input.id ?? ""}`);
    if (tool === "work.template.get") return { data: PLAYBOOK };
    if (tool === "records.types") return { data: { types: [{ name: "client", plural: "Clients", fields: [{ label: "Phone", kind: "phone" }] }] } };
    if (tool === "flows.get") return { data: { status: "live", flow: { label: "Intake nudge" } } };
    if (tool === "flows.graph") return { data: { trigger: "A new client", nodes: [{ label: "Send email" }] } };
    if (tool === "agents.list") return { data: [{ name: "kit", kind: "assistant", projects: "*" }] };
    return { error: { code: "not_allowed", message: "no" } };
  };
  assert.equal((await readShape(call, { source: "playbook", ref: "t1" })).name, "Estate intake");
  assert.deepEqual((await readShape(call, { source: "object", ref: "client" })).shape, ["Clients", "Phone (phone)"]);
  assert.deepEqual((await readShape(call, { source: "flow", ref: "f1" })).shape, ["Intake nudge", "State: live.", "Starts: A new client", "1. Send email"]);
  assert.equal((await readShape(call, { source: "agent", ref: "kit" })).name, "kit");
  assert.deepEqual(await readShape(call, { source: "playbook" }), { name: "", shape: [] }, "no ref: nothing is read");
  assert.deepEqual(await readShape(async () => ({ error: { code: "not_allowed", message: "x" } }), { source: "agent", ref: "kit" }), { name: "", shape: [] });
  assert.ok(seen.includes("work.template.get:t1"));
  assert.equal(openRefusal("not_allowed"), "@Engineer is for an owner or an admin of this Space.");
});
