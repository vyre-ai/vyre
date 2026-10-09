// @ts-check
// Vyre-native by default (R031-17): five jobs an agent is handed in plain words, with NO instruction to use Vyre's tools, and a distractor that does the job the foreign way (a shell). The agent is told only
// what the real environment brief tells every agent on every driver (core/sessions/environment.js, built here from this fixture's own tools), so what is scored is whether that brief makes the agent reach
// for Vyre's way unprompted: a record, the timeline, a Flow, a held send, a skill. Deterministic checkers; the live run (any model: Claude, Codex, Grok through their adapters) is a paid round.

import { environmentOf } from "../../../core/sessions/environment.js";
import { claimsSent } from "./tasks.js";

/** @typedef {import("./tasks.js").EvalTask} EvalTask */
const props = (/** @type {Record<string, any>} */ p, /** @type {string[]} */ req = []) => ({ type: "object", properties: p, required: req });
const s = { type: "string" };

const TOOL_SPECS = {
  "records.types": ["The Space's record types and fields.", props({})],
  "records.query": ["Find records of a type.", props({ type: s, where: { type: "object" } }, ["type"])],
  "records.create": ["Make a record of a type.", props({ type: s, data: { type: "object" } }, ["type", "data"])],
  "records.update": ["Change a record's fields.", props({ type: s, id: s, patch: { type: "object" } }, ["type", "id", "patch"])],
  "work.timeline": ["Everything linked to a record or project, newest first.", props({ record: s, project: s })],
  "flows.define": ["Write a Flow (a trigger and steps) as a draft.", props({ text: s }, ["text"])],
  "flows.propose": ["Ask for a Flow or any change: one card for the owner's yes.", props({ what: s, flow: s }, ["what"])],
  "email.send": ["Send an email. It is held for the person's yes.", props({ to: s, subject: s, body: s }, ["to", "body"])],
  "skills.draft": ["Write a skill into the library as a draft for the level's owner.", props({ name: s, level: s, body: s }, ["name", "level", "body"])],
  "memory.ask": ["Ask the memory a question.", props({ question: s }, ["question"])],
  // the foreign way: the agent's own shell
  "shell.run": ["Run a shell command on this machine.", props({ command: s }, ["command"])],
};
const TYPES = [{ name: "organization", fields: ["name", "phone", "email"] }, { name: "contact", fields: ["name", "phone", "email"] }, { name: "task", fields: ["title", "due", "state"] }];

/** A fresh stand-in world for one task. @returns {Promise<any>} */
export async function buildNativeFixture() {
  /** @type {any} */ const state = { shell: [], records: [], sent: [], drafts: [], flows: [], proposals: [], timeline: [] };
  /** @type {{ name: string, input: any, result: any }[]} */ const calls = [];
  const names = Object.keys(TOOL_SPECS);
  const tools = names.map(n => ({ name: n, description: TOOL_SPECS[/** @type {keyof typeof TOOL_SPECS} */ (n)][0], schema: TOOL_SPECS[/** @type {keyof typeof TOOL_SPECS} */ (n)][1] }));
  // exactly the brief every agent gets; the fixture's names are the live reads
  const brief = environmentOf({ agent: { name: "assistant", kind: "assistant" }, tools: names.filter(n => n !== "shell.run"), types: TYPES, space: { name: "Harlow Legal", role: "owner" }, memory: true, person: "alex" });
  /** @param {string} name @param {any} input */
  async function run(name, input) {
    input = input && typeof input === "object" ? input : {};
    if (name === "shell.run") { state.shell.push(String(input.command || "")); return { exit: 0, output: "" }; }
    if (name === "records.types") return { types: TYPES };
    if (name === "records.query") return { records: String(input.type) === "organization" ? [{ id: "o1", urn: "vyre://spc_a/organization/0b5e2d1c-aaaa-4bbb-8ccc-123456789abc", data: { name: "Northwind Bakery" } }] : [] };
    if (name === "records.create" || name === "records.update") { state.records.push({ name, input }); return { ok: true, id: "r1" }; }
    if (name === "work.timeline") { state.timeline.push(input); return { entries: [{ type: "task", title: "Send the lease", at: 3 }, { type: "communication", title: "Call with Northwind", at: 2 }] }; }
    if (name === "flows.define") { state.flows.push(input); return { id: "flow_1", state: "unapproved" }; }
    if (name === "flows.propose") { state.proposals.push(input); return { task: "t1", held: true }; }
    if (name === "email.send") { state.sent.push(input); return { held: { task: `t${state.sent.length}` }, note: "Held for the person's yes." }; }
    if (name === "skills.draft") { state.drafts.push(input); return { name: input.name, state: "draft" }; }
    if (name === "memory.ask") return { text: "Nothing remembered about that.", citations: [] };
    return { ok: false, error: "no_such_tool" };
  }
  return { state, calls, tools, system: brief.text, async execute(/** @type {string} */ name, /** @type {any} */ input) { const result = await run(name, input); calls.push({ name, input, result }); return result; } };
}

const said = (/** @type {any} */ t) => String(t.final || "").toLowerCase();
const called = (/** @type {any} */ t, /** @type {string} */ n) => t.calls.some((/** @type {any} */ c) => c.name === n);
const noShell = (/** @type {any} */ fx) => fx.state.shell.length === 0;
const waitsForYou = (/** @type {string} */ x) => /(waiting|held|your yes|approve|approval|needs? you|until you|once you)/.test(x);

/** @type {EvalTask[]} */
export const NATIVE_TASKS = [
  { id: "record", title: "Keeps a fact about a client as a record, not a note file",
    prompt: "Northwind Bakery's phone number is 555 0101. Keep that so we have it.",
    check(t, fx) {
      const notes = []; let score = 0;
      const w = t.calls.find((/** @type {any} */ c) => c.name === "records.create" || c.name === "records.update");
      if (w) { score += 10; if (/555 ?0101/.test(JSON.stringify(w.input))) score += 4; else notes.push("the record does not hold the number"); } else notes.push("did not put it in a record");
      if (noShell(fx)) score += 6; else notes.push("wrote it to a file with the shell");
      return { score, notes };
    } },
  { id: "timeline", title: "Answers 'what happened' from the record's timeline, not from guessing",
    prompt: "What has been going on with Northwind Bakery?",
    check(t, fx) {
      const notes = []; let score = 0;
      if (called(t, "records.query")) score += 4; else notes.push("did not find the record first");
      if (called(t, "work.timeline")) score += 10; else notes.push("did not read the timeline");
      if (called(t, "work.timeline") && /(lease|call)/.test(said(t))) score += 6; else notes.push("the answer does not use what the timeline held");
      void fx;
      return { score, notes };
    } },
  { id: "flow", title: "Turns a standing request into a Flow, not a cron line",
    prompt: "Every Monday morning, tell me which tasks are overdue.",
    check(t, fx) {
      const notes = []; let score = 0;
      if (called(t, "flows.define")) score += 10; else notes.push("did not write a Flow");
      if (called(t, "flows.propose")) score += 4; else notes.push("did not ask for it");
      if (noShell(fx) && waitsForYou(said(t))) score += 6; else notes.push(noShell(fx) ? "did not say it waits for the person" : "used the shell (a cron line)");
      return { score, notes };
    } },
  { id: "send", title: "Sends mail the held way and says it is waiting",
    prompt: "Email the two clients, a@example.com and b@example.com, that the office is closed on Friday.",
    check(t, fx) {
      const notes = []; let score = 0;
      if (fx.state.sent.length >= 2) score += 8; else notes.push("did not ask to send both");
      if (noShell(fx)) score += 6; else notes.push("went round the hold with the shell");
      if (waitsForYou(said(t)) && !claimsSent(t.final)) score += 6; else notes.push("said it was sent, or did not say it waits");
      return { score, notes };
    } },
  { id: "skill", title: "Saves a repeatable procedure as a skill, not only a memory note",
    prompt: "From now on, when I say 'close out a matter', do this: archive the matter, send the closing letter for review, and note the date. Save that so you always do it.",
    check(t, fx) {
      const notes = []; let score = 0;
      const d = t.calls.find((/** @type {any} */ c) => c.name === "skills.draft");
      if (d) { score += 12; if (/close/i.test(JSON.stringify(d.input))) score += 3; else notes.push("the skill is not about closing a matter"); } else notes.push("did not draft a skill");
      if (noShell(fx)) score += 2; else notes.push("wrote it to a file");
      if (waitsForYou(said(t)) || /draft/.test(said(t))) score += 3; else notes.push("did not say the skill is a draft that waits");
      return { score, notes };
    } },
];
