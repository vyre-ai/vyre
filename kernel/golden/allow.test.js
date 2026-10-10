// The golden allow file is generated, never hand-written: scripts/gen-allow.mjs builds it from core/modules/agent-reach.js (OPEN and ASK_FIRST) and the flows manifest.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { OPEN, ASK_FIRST, PERSON_ONLY } from "../../core/modules/agent-reach.js";
import { generate, render, flowsAnyone, memoryAnyone, ALLOW_FILE, OPEN_NOTES, FLOWS_NOTES, MEMORY_NOTES, DECLARED, DECLARED_SINCE, DECLARED_NOTES } from "../../scripts/gen-allow.mjs";

const committed = () => JSON.parse(fs.readFileSync(ALLOW_FILE, "utf8"));

test("the committed allow file is exactly the generator's output: nothing hand-written, nothing stale", () => {
  assert.equal(fs.readFileSync(ALLOW_FILE, "utf8"), render(generate()), "run: npm run golden:allow");
});

test("every allow entry is a tool in OPEN, ASK_FIRST or DECLARED, or a reach anyone flows tool or a memory tool whose module authenticates the chain", () => {
  const flows = new Set(flowsAnyone()), memory = new Set(memoryAnyone());
  for (const e of committed()) {
    assert.deepEqual(Object.keys(e).sort(), ["reason", "tool"], `${e.tool}: only tool and reason`);
    assert.ok(OPEN.has(e.tool) || ASK_FIRST.has(e.tool) || flows.has(e.tool) || memory.has(e.tool) || e.tool in DECLARED || e.tool in DECLARED_SINCE, `${e.tool} is in none of OPEN, ASK_FIRST, DECLARED, the flows or the memory lists`);
    if (flows.has(e.tool)) assert.match(e.reason, /module authenticates the caller's chain/, `${e.tool}: a flows entry says the module authenticates the chain`);
  }
});

test("no person-only tool is allowed", () => {
  for (const e of committed()) assert.equal(PERSON_ONLY.has(e.tool), false, `${e.tool} is person only`);
  for (const t of ["flows.approve", "flows.pause", "flows.resume", "flows.kit.remove", "files.drive.access", "threads.mode"]) assert.equal(committed().some(e => e.tool === t), false, t);
});

test("every OPEN and ASK_FIRST tool has an entry, each with its own reason (no bulk text)", () => {
  const have = new Map(committed().map(e => [e.tool, e.reason]));
  for (const t of [...OPEN, ...ASK_FIRST.keys()]) assert.ok(have.has(t), `${t} has no allow entry`);
  const reasons = [...have.values()];
  assert.equal(new Set(reasons).size, reasons.length, "two entries share one reason");
  for (const [t, r] of have) assert.ok(r.length > 60, `${t}: reason too short`);
});

test("a note exists only for a tool that is still classified", () => {
  for (const t of Object.keys(OPEN_NOTES)) assert.ok(OPEN.has(t) || ASK_FIRST.has(t), `${t} has a note but is not in OPEN or ASK_FIRST`);
  const flows = new Set(flowsAnyone());
  for (const t of Object.keys(FLOWS_NOTES)) assert.ok(flows.has(t), `${t} has a flows note but is not a reach anyone flows tool`);
});

test("the six declared-anyone tools of 4 Oct are not in the allow file", () => {
  for (const t of ["bridges.continue", "bridges.copy", "bridges.resolve", "bridges.view.read", "spaces.code.submit", "spaces.invites.redeem"]) assert.equal(committed().some(e => e.tool === t), false, t);
});

test("the generator refuses a person-only tool and an open tool with no note", () => {
  // generate() throws on both; the exported lists prove the tools it walks are all covered today
  for (const t of OPEN) assert.ok(t in OPEN_NOTES, `${t} has no note`);
  for (const t of flowsAnyone()) assert.ok(t in FLOWS_NOTES, `${t} has no flows note`);
});

test("every DECLARED tool has its own entry naming the commit, none is person only or ask first, and a note exists only for a declared tool", () => {
  const have = new Map(committed().map(e => [e.tool, e.reason]));
  for (const [t, ref] of Object.entries({ ...DECLARED, ...DECLARED_SINCE })) {
    const c = String(ref).split("@")[0];
    assert.ok(have.has(t), `${t} has no allow entry`);
    assert.ok(have.get(t).includes(c), `${t}: the reason names ${c}`);
    assert.equal(PERSON_ONLY.has(t) || ASK_FIRST.has(t), false, `${t} is person only or ask first, so it is not declared here`);
  }
  for (const t of Object.keys(DECLARED_NOTES)) assert.ok(t in DECLARED || t in DECLARED_SINCE, `${t} has a note but is not declared`);
  for (const t of ["threads.delete", "threads.rewind"]) assert.ok(ASK_FIRST.has(t) && have.has(t), `${t} is ask first and has an entry`);
});

// A ruled presence removal on a tool a person does (kernel/golden/presence.json, generated from PRESENCE_RULINGS): narrow, and never a way to open a tool to a model.
import { generatePresence, PRESENCE_FILE, PRESENCE_RULINGS, SURFACE_RULINGS } from "../../scripts/gen-allow.mjs";
import { weakened, presenceAllow, risky } from "./index.js";

test("the committed presence file is exactly the generator's output, and every entry names a ruling, one refusal (presence_required, or denied for a surface ruling) and person callers only", () => {
  assert.equal(fs.readFileSync(PRESENCE_FILE, "utf8"), render(generatePresence()), "run: npm run golden:allow");
  for (const e of JSON.parse(fs.readFileSync(PRESENCE_FILE, "utf8"))) {
    assert.match(e.ruling, /(CHAT|ROADMAP)\.md/);
    assert.ok(["denied", "presence_required", "person_session_required"].includes(e.was), `${e.tool}: ${e.was}`);
    if (e.was === "denied") assert.ok(e.tool in SURFACE_RULINGS, `${e.tool}: a denied cell is excused only by a surface ruling`);
    assert.ok(e.callers.length > 0 && !e.callers.some(risky), `${e.tool}: no model, guest, MCP or harness caller`);
  }
});

test("the gate lets a ruled presence removal through only for its tool, its person callers and the refusal it replaced", () => {
  const mk = (tool, caller, was, now = "would run") => ({ a: { roles: { box: { rows: { [tool]: "A" }, emptyBad: {} } }, callers: [caller], worlds: ["w"], legend: { A: was } }, b: { roles: { box: { rows: { [tool]: "B" }, emptyBad: {} } }, callers: [caller], worlds: ["w"], legend: { B: now } } });
  const allow = presenceAllow();
  const { a, b } = mk("spaces.host-here", "deck", "presence_required");
  assert.deepEqual(weakened(a, b, allow), [], "the ruled cell passes");
  assert.equal(weakened(a, b, []).length, 1, "and without the ruling it is refused");
  const other = mk("spaces.host-here", "deck", "not_a_member");
  assert.equal(weakened(other.a, other.b, allow).length, 1, "another refusal of the same tool is not excused");
  const agent = mk("spaces.host-here", "cli:agent:kit", "presence_required");
  assert.equal(weakened(agent.a, agent.b, allow).length, 1, "a model caller is not excused");
  const tool2 = mk("spaces.members.add", "deck", "presence_required");
  assert.equal(weakened(tool2.a, tool2.b, allow).length, 1, "another tool is not excused");
  // the ruled removals name person callers only (checked above for every entry), so a tool listed here is not thereby open to a model: that is OPEN, ASK_FIRST and DECLARED
  assert.ok(Object.values(PRESENCE_RULINGS).every(r => r.callers.every(c => !risky(c))), "no ruled removal names a model, guest, MCP or harness caller");
});

test("a surface ruling excuses its tool, its person callers and the one refusal (denied), and nothing else", () => {
  const mk = (tool, caller, was, now = "would run") => ({ a: { roles: { box: { rows: { [tool]: "A" }, emptyBad: {} } }, callers: [caller], worlds: ["w"], legend: { A: was } }, b: { roles: { box: { rows: { [tool]: "B" }, emptyBad: {} } }, callers: [caller], worlds: ["w"], legend: { B: now } } });
  const allow = presenceAllow();
  const ok = mk("vault.import", "capsule", "denied");
  assert.deepEqual(weakened(ok.a, ok.b, allow), []);
  for (const caller of ["mcp", "cli:agent:kit", "tailnet-guest", "harness"]) { const m = mk("vault.import", caller, "denied"); assert.equal(weakened(m.a, m.b, allow).length, 1, `${caller} is not excused`); }
  const refused = mk("vault.import", "capsule", "presence_required");
  assert.equal(weakened(refused.a, refused.b, allow).length, 1, "another refusal is not excused");
  const other = mk("vault.reveal", "capsule", "denied");
  assert.equal(weakened(other.a, other.b, allow).length, 1, "another tool is not excused");
  const phoneOnly = mk("vault.env.scan", "deck", "denied");
  assert.equal(weakened(phoneOnly.a, phoneOnly.b, allow).length, 1, "env.scan is excused for the phone only");
});

test("every memory tool a model may call has a note, and a note is only for a tool the manifest still has", () => {
  const have = new Set(memoryAnyone());
  for (const t of Object.keys(MEMORY_NOTES)) assert.ok(have.has(t), `${t} has a memory note but is not a memory manifest tool`);
  for (const t of have) assert.equal(PERSON_ONLY.has(t), false, `${t} is person only`);
});
