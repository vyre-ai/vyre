// @ts-check
// memory.answer: questions parsed by rules, answered from personal facts, the graph, then the
// user's own words; silent when it does not know; refused to a project's agent.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../../store/index.js";
import { seedRecall } from "../../../test/fixtures/corpus.js";
import { tempHome } from "../../../test/helpers.js";
import { search } from "../../recall/search.js";
import { parse, normalize } from "./answer.js";
import memory from "../index.js";

const T0 = Date.parse("2026-05-01T09:00:00Z");
const DAY = 86_400_000;
let n = 0;
/** A fictional session: strings are user turns, { a: text } Claude's. */
const S = (turns, { day = 0, name, cwd = "/home/alex/Work/misc" } = {}) => ({
  id: `55555555-eeee-4000-8000-${String(++n).padStart(12, "0")}`, cwd, start: T0 + day * DAY, ...(name ? { name } : {}),
  turns: turns.map(x => (typeof x === "string" ? { role: /** @type {"user"|"assistant"} */ ("user"), text: x } : { role: /** @type {"user"|"assistant"} */ ("assistant"), text: x.a })),
});

const LIFE = [
  S(["My wife Jordan wants the Harlow site in dark mode.", { a: "Added a dark mode toggle." }], { day: 1 }),
  S(["Jordan's birthday is 14 March, keep that evening free.", { a: "Noted." }], { day: 2 }),
  S(["My green Subaru Outback failed its inspection, so I'm stuck at home.", { a: "Working from home then." }], { day: 3 }),
  S(["Just bought a blue Volvo XC40, picking it up tomorrow.", { a: "Congratulations." }], { day: 40 }),
  S(["Sold the Outback this weekend, one less thing to worry about.", { a: "Good." }], { day: 41 }),
  S(["Driving the XC40 to Harlow for the review.", { a: "Good luck." }], { day: 50 }),
  S(["I live in Portland, so schedule calls on Pacific time.", { a: "Done." }], { day: 5 }),
  S(["Moved to Seattle last weekend, boxes everywhere.", { a: "Welcome to Seattle." }], { day: 60 }),
  S(["I live in Seattle now, update my address.", { a: "Updated." }], { day: 62 }),
  S(["My dog Biscuit chewed the charger.", { a: "Oh no." }], { day: 7 }),
  S(["My mom Ruth is visiting this weekend.", { a: "Enjoy." }], { day: 8 }),
  S(["My sister Maya is opening a bakery.", { a: "Nice." }], { day: 9 }),
  S(["My dad Tom is flying in on Friday.", { a: "Noted." }], { day: 10 }),
  S(["My dad Tim fixed the sink, so I'm back at the desk.", { a: "Good." }], { day: 10.5 }),
  S(["My studio, Rivera Studio, needs a cleaner invoice template.", { a: "On it." }], { day: 11 }),
  S(["Harlow Legal is my biggest client, so their fixes come first.", { a: "Understood." }], { day: 12 }),
  S(["I use Neovim, so give me the keybinding.", { a: "Here it is." }], { day: 13 }),
  S(["I prefer tea over coffee, so skip the coffee order.", { a: "Skipped." }], { day: 14 }),
  S(["My gym is Ironworks downtown, book the 7am class.", { a: "I can't book it, but here is the link." }], { day: 15 }),
  S(["I skipped the pool today, too tired.", { a: "Rest up." }], { day: 16 }),
  S(["Imagine my son wanted a site like this one, how long would it take?", { a: "About two weeks." }], { day: 17 }),
  S(["what is my wife's name?", { a: "I can't see it here." }], { day: 18, name: "Capsule: what is my wife's name" }),
  S(["Dana Reyes at Harlow Legal signed off on the homepage.", { a: "Great." }], { day: 19, cwd: "/home/alex/Work/harlow-site" }),
];

const PROJECTS = [{ slug: "harlow", name: "Harlow Legal", home: "/home/alex/Work/harlow-site", workspaces: [], threads: 1, picked: 0, picks: [] }];
const AGENTS = [{ name: "kit", projects: ["harlow"] }, { name: "juno", kind: "assistant" }, { name: "hal", projects: "*" }];

async function world(t) {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, LIFE);
  const tools = new Map();
  const ctx = {
    name: "memory", config: { me: { name: "Alex Rivera", domains: ["riverastudio.com"] } }, paths: {}, store: { db, migrate: () => {} }, log: () => {},
    events: { on: () => () => {}, emit: () => {}, since: () => [], prune: () => 0 },
    call: async (tool, input) => {
      if (tool === "recall.search") return { data: (await search(db, input, null, null)).hits };
      if (tool === "projects.list") return { data: { projects: PROJECTS } };
      if (tool === "agents.list") return { data: AGENTS };
      return { error: { code: "no_such_tool", message: tool } };
    },
    tool: (name, def) => tools.set(name, def),
  };
  const handle = await memory.start(ctx);
  t.after(() => handle.stop());
  const call = async (name, input, caller = "cli") => {
    try { return { data: await tools.get(name).run(input, { caller }) }; } catch (e) { return { error: /** @type {Error} */ (e).message, code: /** @type {any} */ (e).code || "failed" }; }
  };
  await call("memory.curate", { full: true });
  const ask = async (q, extra = {}) => { const r = await call("memory.answer", { q, ...extra }); assert.ok(!r.error, r.error); return r.data; };
  return { call, ask, tools };
}

test("answer: questions are parsed by rules, typos and case forgiven", () => {
  assert.equal(normalize("whats my wfie's name?"), "what is my wife name");
  assert.equal(normalize("WHO IS MY WIFE?"), "who is my wife");
  assert.equal(normalize("wifes bday"), "wife bday");
  const table = [
    ["What is the name of my wife?", { kind: "kin", word: "wife", role: "spouse" }],
    ["what's my wife called", { kind: "kin", word: "wife", role: "spouse" }],
    ["my wifes name", { kind: "kin", word: "wife", role: "spouse" }],
    ["my mum's name", { kind: "kin", word: "mum", role: "mother" }],
    ["dog name", { kind: "kin", word: "dog", role: "dog" }],
    ["wife's birthday", { kind: "birthday", who: { kin: "wife" } }],
    ["when is Jordan's birthday", { kind: "birthday", who: { name: "jordan" } }],
    ["when is my birthday", { kind: "birthday", who: { me: true } }],
    ["which car do I own", { kind: "car", before: null, color: false }],
    ["what do I drive", { kind: "car", before: null, color: false }],
    ["what colour is my car", { kind: "car", before: null, color: true }],
    ["what car did I have before the Volvo", { kind: "car", before: "volvo", color: false }],
    ["where do I live", { kind: "lives", before: null }],
    ["where am I based", { kind: "lives", before: null }],
    ["where did I live before Seattle", { kind: "lives", before: "seattle" }],
    ["where do I work", { kind: "work" }],
    ["who are my clients", { kind: "clients" }],
    ["who is my contact at Harlow Legal", { kind: "contact", org: "harlow legal" }],
    ["what editor do I use", { kind: "uses", cat: "editor" }],
    ["do I prefer tea or coffee", { kind: "prefers", options: ["tea", "coffee"], cat: null }],
    ["what do I prefer to drink", { kind: "prefers", options: [], cat: "drink" }],
    ["what's my name", { kind: "myname" }],
    ["who is Dana Reyes", { kind: "who", name: "dana reyes" }],
    ["who's jordan", { kind: "who", name: "jordan" }],
    ["who is my dentist", { kind: "attr", noun: "dentist" }],
    ["where was I born", { kind: "born" }],
    ["what phone do I have", { kind: "owns", cat: "phone" }],
  ];
  for (const [q, want] of table) assert.deepEqual(parse(String(q)), want, String(q));
  assert.equal(parse("refactor the invoice watcher"), null);
});

test("answer: one line from personal facts, current values, the earlier one when asked", async t => {
  const { ask } = await world(t);
  const wife = await ask("name of my wife");
  assert.equal(wife.answer, "Your wife is Jordan.");
  assert.equal(wife.kind, "fact");
  assert.equal(wife.via, "fact");
  assert.ok(wife.confidence >= 0.5);
  assert.ok(wife.from >= 1);
  assert.ok(wife.facts.some(f => f.rel === "name" && f.object === "Jordan"));
  for (const k of ["id", "subject", "rel", "object", "confidence", "sessions", "first_seen", "last_seen"]) assert.ok(k in wife.facts[0], k);
  assert.ok(wife.sources.length >= 1 && wife.sources.length <= 3);
  assert.match(wife.sources[0].quote, /Jordan/);
  assert.ok(typeof wife.ms === "number" && wife.ms >= 0);

  assert.equal((await ask("whats my wfie's name")).answer, "Your wife is Jordan.");
  assert.equal((await ask("When is my wife's birthday?")).answer, "Jordan's birthday is 14 March.");
  assert.equal((await ask("jordan birthday")).answer, "Jordan's birthday is 14 March.");
  assert.equal((await ask("who is Jordan")).answer, "Jordan is your wife.");
  assert.equal((await ask("what do I drive")).answer, "You drive a blue Volvo XC40.");
  assert.equal((await ask("what colour is my car")).answer, "Your Volvo XC40 is blue.");
  assert.equal((await ask("what car did I have before the Volvo")).answer, "Before the Volvo XC40 you had a green Subaru Outback.");
  assert.equal((await ask("where do I live")).answer, "You live in Seattle.");
  assert.equal((await ask("where did I live before Seattle")).answer, "Before Seattle you lived in Portland.");
  assert.equal((await ask("where do I work")).answer, "You work at Rivera Studio.");
  assert.equal((await ask("what's my dog's name")).answer, "Your dog is Biscuit.");
  assert.equal((await ask("who is Ruth")).answer, "Ruth is your mom.");
  assert.equal((await ask("what editor do I use")).answer, "You use Neovim.");
  assert.equal((await ask("do I prefer tea or coffee")).answer, "You prefer tea over coffee.");
  // Who the user is comes from their own setup when no conversation said it.
  const me = await ask("what is my name");
  assert.equal(me.answer, "Your name is Alex Rivera.");
  assert.equal(me.from, 0);
  // Outside people come from the graph.
  assert.match(String((await ask("who is Dana Reyes")).answer), /^Dana Reyes works at Harlow Legal, your client\.$/);
  assert.equal((await ask("who is my contact at Harlow Legal")).answer, "Your contact at Harlow Legal is Dana Reyes.");
  // sources: true lists more, each with a quote.
  const more = await ask("where do I live", { sources: true });
  assert.ok(more.sources.length >= 2 && more.sources.every(s => s.session && typeof s.seq === "number" && s.quote));
});

test("answer: never a confident wrong answer; unknowns come back null, rivals as maybe", async t => {
  const { ask } = await world(t);
  for (const q of ["what is my son's name", "what is my cat's name", "what is my daughter's name", "which bank do I use", "where was I born",
    "what phone do I have", "who is my dentist", "what is my blood type", "what is my brother's name"]) {
    const r = await ask(q);
    assert.equal(r.answer, null, `${q} -> ${r.answer}`);
    assert.equal(r.confidence, null);
    assert.equal(r.kind, null);
    assert.equal(r.via, null);
  }
  // A dog is not the answer about a cat, and a pool the user skipped is not their gym.
  assert.equal((await ask("what is my cat's name")).answer, null);
  // Two names for one father, once each: neither is sure, and "who is" keeps the name asked.
  const dad = await ask("my dad's name");
  assert.ok(dad.confidence < 0.5 && dad.confidence >= 0.3, String(dad.confidence));
  assert.match(String(dad.answer), /^Maybe your dad is (Tom|Tim)\.$/);
  const tom = await ask("who is Tom");
  assert.equal(tom.answer, "Maybe Tom is your dad.");
  assert.ok(tom.confidence < 0.5);
  // A sister is not a singular role: two names are two sisters.
  assert.equal((await ask("my sister's name")).answer, "Your sister is Maya.");
  // A relation with no fact takes only a sentence that states it, never the Capsule's own thread.
  const gym = await ask("what gym do I go to");
  assert.equal(gym.kind, "said");
  assert.equal(gym.answer, "Your gym is Ironworks downtown, book the 7am class.");
  assert.ok(gym.confidence <= 0.45);
  assert.equal(gym.via, "keyword");
  assert.equal(gym.sources.length, 1);
  assert.match(gym.sources[0].quote, /Ironworks/);
});

test("answer: the user's surfaces, their devices, modules and all-projects agents ask; a project's agent is refused", async t => {
  const { call, tools } = await world(t);
  for (const caller of ["cli", "deck", "capsule", "local", "module:watch", "tailnet:alex@example.com", "mcp:agent:juno", "harness:agent:hal"]) {
    const r = await call("memory.answer", { q: "who is my wife" }, caller);
    assert.ok(!r.error, `${caller}: ${r.error}`);
    assert.equal(r.data.answer, "Your wife is Jordan.");
  }
  for (const [caller, input] of [["mcp:agent:kit", {}], ["mcp", {}], ["tailnet:agent:kit", {}], ["cli", { agent: "kit" }], ["mcp", { project_cwds: ["/home/alex/Work/harlow-site"] }], ["mcp:agent:nobody", {}]]) {
    const r = await call("memory.answer", { q: "who is my wife", ...input }, caller);
    assert.equal(r.code, "denied", `${caller} ${JSON.stringify(input)}: ${JSON.stringify(r)}`);
  }
  // question is q by another name (the Claude Code plugin's word for it).
  assert.equal((await call("memory.answer", { question: "who is my wife" })).data.answer, "Your wife is Jordan.");
  assert.ok(tools.get("memory.answer").input.properties.q);
});

test("profile: second-person lines that still hold, strongest first, nothing sensitive", async t => {
  const { call } = await world(t);
  const r = await call("memory.profile", {});
  assert.ok(!r.error, r.error);
  const texts = r.data.facts.map(f => f.text);
  for (const want of ["Your wife is Jordan.", "You drive a blue Volvo XC40.", "You live in Seattle.", "Your dog is Biscuit.", "Harlow Legal is your client."]) {
    assert.ok(texts.includes(want), `${want} in ${JSON.stringify(texts)}`);
  }
  // Gone, rival or dated: the sold car, the old city, a birthday.
  for (const not of [/Outback/, /Portland/, /birthday|March/]) assert.ok(!texts.some(x => not.test(x)), `${not} in ${JSON.stringify(texts)}`);
  for (const f of r.data.facts) {
    assert.ok(f.weight >= 0.5 && f.weight <= 1, JSON.stringify(f));
    assert.ok(["person", "place", "vehicle", "work", "client", "preference", "other"].includes(f.kind), f.kind);
    assert.equal(typeof f.from, "number");
  }
  const w = r.data.facts.map(f => f.weight);
  assert.deepEqual(w, [...w].sort((a, b) => b - a));
  assert.equal((await call("memory.profile", { limit: 2 })).data.facts.length, 2);
  // A told account number or address never reaches a profile line.
  await call("memory.remember", { text: "I work at 1200 Market Street Suite 4." });
  assert.ok(!(await call("memory.profile", { limit: 50 })).data.facts.some(f => /1200/.test(f.text)));
  assert.equal((await call("memory.profile", {}, "mcp:agent:kit")).code, "denied");
});

test("remember: told outright, kept at once, answered at once, no prompt", async t => {
  const { call, ask } = await world(t);
  assert.equal((await ask("what is my brother's name")).answer, null);
  const r = await call("memory.remember", { text: "My brother Leo lives in Denver.", room: "harlow" }, "mcp:agent:juno");
  assert.ok(!r.error, r.error);
  assert.equal(typeof r.data.id, "number");
  assert.equal(r.data.text, "My brother Leo lives in Denver.");
  assert.ok(r.data.facts.some(f => f.rel === "brother" && f.confidence >= 0.9), JSON.stringify(r.data.facts));
  const a = await ask("who is my brother");
  assert.equal(a.answer, "Your brother is Leo.");
  assert.ok(a.confidence >= 0.9);
  assert.equal(a.sources[0].name, "told to memory");
  assert.equal(a.sources[0].session, `told:${r.data.id}`);

  // A correction wins over what was said in passing: told beats two conversations' rule claims.
  await call("memory.remember", { text: "I live in Tacoma now." });
  assert.equal((await ask("where do I live")).answer, "You live in Tacoma.");

  // No rule reads it: kept as a note, found by its words.
  const n = await call("memory.remember", { text: "My locker code rotates every Monday and the gym keeps the spare key." });
  assert.deepEqual(n.data.facts, []);
  const l = await ask("when does my locker code rotate");
  assert.match(String(l.answer), /^Your locker code rotates every Monday/);
  assert.equal(l.kind, "said");

  // A full re-read keeps what was told.
  await call("memory.curate", { full: true });
  assert.equal((await ask("who is my brother")).answer, "Your brother is Leo.");

  for (const caller of ["mcp:agent:kit", "mcp", "tailnet:agent:kit"]) assert.equal((await call("memory.remember", { text: "My brother is Max." }, caller)).code, "denied", caller);
  assert.match(String((await call("memory.remember", { text: "  " })).error), /needs the fact/);
});

test("answer: a lookup is fast", async t => {
  const { ask } = await world(t);
  const ms = [];
  for (let i = 0; i < 20; i++) ms.push((await ask(i % 2 ? "who is my wife" : "what do I drive")).ms);
  ms.sort((a, b) => a - b);
  assert.ok(ms[Math.floor(ms.length * 0.95)] < 150, ms.join(", "));
});
