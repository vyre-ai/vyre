// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentCards, agentHref, areaLine, offTitle, pickerGroups, FAMILY_PREFIXES, refusal, stateFrom, summary, switchCall, toolCall } from "./access-model.js";
import { AREAS } from "../../../../lib/assistant-access.js";

const SAMPLE = { assistant: "assistant", tools: [{ name: "records.*", at: 5 }], screens: [{ id: "vault", label: "Vault", off: true }, { id: "mail", label: "Mail and messages", off: false }] };

test("the page reads the box's state, says what is off, and builds the one call a switch makes", () => {
  const s = stateFrom(SAMPLE);
  assert.deepEqual(s?.screens.map((x) => [x.id, x.off]), [["vault", true], ["mail", false]]);
  assert.equal(summary(s), "2 things are turned off for your agent.");
  assert.match(summary(stateFrom({ screens: [] })), /can do what you can do/);
  assert.equal(stateFrom({}), null);
  assert.equal(areaLine(true), "Your agent cannot use this.");
  assert.deepEqual(switchCall("vault", false), { tool: "assistant.access.narrow", input: { screens: ["vault"] } });
  assert.deepEqual(switchCall("vault", true), { tool: "assistant.access.restore", input: { screens: ["vault"] } });
});

test("a tool to turn off must look like a tool; a refusal is in plain words", () => {
  assert.deepEqual(toolCall("  Records.LIST "), { tool: "assistant.access.narrow", input: { tools: ["records.list"] } });
  assert.deepEqual(toolCall("records.*"), { tool: "assistant.access.narrow", input: { tools: ["records.*"] } });
  assert.match(/** @type {any} */ (toolCall("everything")).problem, /not a tool name/);
  assert.match(/** @type {any} */ (toolCall("")).problem, /Type a tool name/);
  assert.equal(refusal("denied", "x"), "Only you can change what your agent may do.");
  assert.match(refusal("presence_required", ""), /needs your approval/);
});

test("each agent is a card: the assistant first, then the others by name, shown as a person says the name, with a line that says what it is and never its instructions, and a page that exists", () => {
  const cards = agentCards([{ name: "zed", kind: "agent", description: "Reviews contracts\nmore", instructions: "You are Zed. Do many things." }, { name: "qi", kind: "assistant", instructions: "Your name is Qi. You work for Sam." }, { name: "amy", kind: "agent" },
    { name: "engineer", kind: "agent", builtin: true, instructions: "You are the Engineer. You set up the Space for the person you are talking to, by asking and then doing it." }, { nope: 1 }]);
  assert.deepEqual(cards, [
    { name: "qi", title: "Qi", sub: "Your assistant", href: "/u/assistants/qi" },
    { name: "amy", title: "Amy", sub: "Agent", href: "/u/assistants/amy" },
    { name: "engineer", title: "Engineer", sub: "Builds your Space by conversation", href: "/u/assistants/engineer" },
    { name: "zed", title: "Zed", sub: "Reviews contracts", href: "/u/assistants/zed" }]);
  assert.ok(cards.every((c) => !/^You are /.test(c.sub)), "instructions are never a description");
  assert.deepEqual(agentCards({ agents: [{ name: "a", kind: "agent" }] }).map((c) => c.name), ["a"]);
  assert.deepEqual(agentCards(null), []);
  assert.equal(agentHref("a b"), "/u/assistants/a%20b");
});

test("a display name: the assistant's as typed when it matches its id, otherwise the id in words", async () => {
  const { displayName } = await import("../agents/home-model.js");
  assert.equal(displayName({ name: "juno-two", kind: "assistant", instructions: "Your name is Juno Two. You..." }), "Juno Two");
  assert.equal(displayName({ name: "qi", kind: "assistant", instructions: "Your name is Someone Else." }), "Qi", "a typed name that is not this id's is not trusted");
  assert.equal(displayName({ name: "ads-writer", kind: "agent" }), "Ads Writer");
  assert.equal(displayName({ name: "engineer", kind: "agent", instructions: "Your name is Boss." }), "Engineer", "only the assistant carries a typed name");
});

test("the tool picker speaks plain words, leads each family with all of it, hides what is off and what must never be turned off, and finds by word or by id", () => {
  const commands = [
    { module: "records", verb: "list", tool: "records.list", summary: "List the records of a type." },
    { module: "records", verb: "delete", tool: "records.delete", summary: "Delete a record" },
    { module: "mail", verb: "send", tool: "mail.send", summary: "Send an email" },
    { module: "assistant", verb: "check", tool: "assistant.access.check", summary: "x" },
    { module: "zeta", verb: "do-thing", tool: "zeta.do-thing", summary: "" },
  ];
  const all = pickerGroups(commands, [], "");
  assert.deepEqual(all.map((g) => g.title), ["Mail and messages", "Records and contacts", "Zeta"]);
  assert.deepEqual(all[1].all, { name: "records.*", label: "All of Records and contacts" });
  assert.deepEqual(all[1].tools.map((t) => t.label), ["Delete a record", "List the records of a type"]);
  assert.equal(all[2].tools[0].label, "Do thing", "no summary: the verb in words");
  assert.ok(!JSON.stringify(all).includes("assistant.access"), "the assistant can always read what it may not do");
  assert.deepEqual(pickerGroups(commands, ["records.delete", "mail.*"], "").flatMap((g) => g.tools.map((t) => t.id)), ["records.list", "zeta.do-thing"]);
  assert.deepEqual(pickerGroups(commands, [], "email").flatMap((g) => g.tools.map((t) => t.id)), ["mail.send"]);
  assert.deepEqual(pickerGroups(commands, [], "records.del").flatMap((g) => g.tools.map((t) => t.id)), ["records.delete"], "an id still finds it");
  assert.deepEqual(pickerGroups(commands, [], "contacts").map((g) => g.family), ["records"], "a word of the area finds the whole family");
  assert.deepEqual(pickerGroups(null, [], ""), []);
});

test("every family an area covers has its plain words in the picker", () => {
  for (const a of AREAS) for (const f of a.tools) assert.ok(FAMILY_PREFIXES.includes(f.replace(/\.\*$/, "")), f);
});

test("a tool that is off is named in words; the id is only the fallback", () => {
  const commands = [{ tool: "mail.send", summary: "Send an email." }];
  assert.equal(offTitle("mail.*", commands), "All of Mail and messages");
  assert.equal(offTitle("zeta.*", commands), "All of Zeta");
  assert.equal(offTitle("mail.send", commands), "Send an email");
  assert.equal(offTitle("mail.read", commands), "mail.read");
});
