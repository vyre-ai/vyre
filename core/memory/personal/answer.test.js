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
import { parse, normalize, answerer } from "./answer.js";
import { Personal } from "./store.js";
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

async function world(t, life = LIFE) {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, life);
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
  // Bare "mcp" is the user's own Claude Code session, in whatever folder it runs.
  for (const [caller, input] of [["cli"], ["deck"], ["capsule"], ["local"], ["module:watch"], ["tailnet:alex@example.com"], ["mcp:agent:juno"], ["harness:agent:hal"],
    ["mcp"], ["mcp", { project_cwds: ["/home/alex/Work/harlow-site"] }], ["mcp:thread:t_42"]]) {
    const r = await call("memory.answer", { q: "who is my wife", ...input }, caller);
    assert.ok(!r.error, `${caller}: ${r.error}`);
    assert.equal(r.data.answer, "Your wife is Jordan.");
  }
  for (const [caller, input] of [["mcp:agent:kit", {}], ["mcp", { agent: "kit" }], ["tailnet:agent:kit", {}], ["cli", { agent: "kit" }], ["harness", {}], ["mcp:agent:nobody", {}], ["mcp:thread:t_42 agent:kit", {}], ["mcp:thread:", {}]]) {
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
  assert.ok((await call("memory.profile", {}, "mcp")).data.facts.length > 0, "the user's own Claude Code session");
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

  for (const caller of ["mcp:agent:kit", "harness", "tailnet:agent:kit"]) assert.equal((await call("memory.remember", { text: "My brother is Max." }, caller)).code, "denied", caller);
  // The user's own Claude Code session (/vyre remember through the plugin) keeps a fact.
  const cc = await call("memory.remember", { text: "My sister Ana lives in Austin." }, "mcp");
  assert.ok(!cc.error, cc.error);
  assert.match(String((await ask("who is my sister")).answer), /Ana/);
  assert.match(String((await call("memory.remember", { text: "  " })).error), /needs the fact/);
});

test("answer: a lookup is fast", async t => {
  const { ask } = await world(t);
  const ms = [];
  for (let i = 0; i < 20; i++) ms.push((await ask(i % 2 ? "who is my wife" : "what do I drive")).ms);
  ms.sort((a, b) => a - b);
  assert.ok(ms[Math.floor(ms.length * 0.95)] < 150, ms.join(", "));
});

test("answer: new question shapes parse", () => {
  const table = [
    ["which city am i in now", { kind: "lives", before: null }],
    ["what do i do for work", { kind: "job" }],
    ["what's my job", { kind: "job" }],
    ["what app do i keep my notes in", { kind: "uses", cat: "notes" }],
    ["hubby's name?", { kind: "kin", word: "hubby", role: "spouse" }],
  ];
  for (const [q, want] of table) assert.deepEqual(parse(String(q)), want, String(q));
});

test("answer: a life typed in lower case, in passing", async t => {
  const { ask } = await world(t, [
    S(["my partner jordan says the logo looks too corporate, thoughts?", { a: "A lighter weight would soften it." }], { day: 1 }),
    S(["jordan and i are off to denver for the weekend", { a: "Understood." }], { day: 2 }),
    S(["hubby's cooking tonight so i can push through this", { a: "Enjoy." }], { day: 3 }),
    S(["my son sam snapped my pencil", { a: "Oh no." }, "sam's football is at 5 so hard stop", { a: "Noted." }], { day: 4 }),
    S(["my daughter maya drew all over my sketchbook", { a: "Ha." }, "maya's got a temperature so i'm home", { a: "Hope she's ok." }], { day: 5 }),
    S(["for context im a freelance designer, mostly figma but i do a bit of front end", { a: "Got it." }], { day: 6 }),
    S(["i keep all my notes in obsidian, can you give me a template", { a: "Here is one." }], { day: 7 }),
    S(["my two clients right now are harlow legal and northwind bakery", { a: "Noted." }], { day: 8 }),
    S(["dana from harlow legal emailed again about the photos", { a: "Want a reply drafted?" }], { day: 9 }),
    S([`can you help me reply to this from dana:\n\n"Hi Alex, my wife Claire and I are away from the 12th. Best, Dana Reyes"`, { a: "Here is a reply." }], { day: 10 }),
  ]);
  assert.equal((await ask("whats my husband's name")).answer, "Your husband is Jordan.");
  assert.equal((await ask("who is my partner")).answer, "Your partner is Jordan.");
  assert.equal((await ask("who's jordan")).answer, "Jordan is your husband.", "the plain word, not 'hubby'");
  assert.equal((await ask("what are my kids called")).answer, "Your kids are Sam and Maya.");
  assert.equal((await ask("what's my job")).answer, "You are a freelance designer.");
  assert.equal((await ask("what design tool do i use")).answer, "You use Figma.");
  assert.equal((await ask("what app do i keep my notes in")).answer, "You use Obsidian.");
  assert.equal((await ask("who are my clients")).answer, "Your clients are Harlow Legal and Northwind Bakery.");
  assert.equal((await ask("who is my contact at harlow legal")).answer, "Your contact at Harlow Legal is Dana.");
  assert.equal((await ask("who is dana reyes")).answer, "Dana works at Harlow Legal, your client.");
  // The pasted email's wife is Dana's, and a husband is never the answer about a wife.
  const wife = await ask("what's my wife's name");
  assert.ok(!wife.answer || wife.confidence < 0.5, JSON.stringify(wife));
  assert.ok(!/Claire/.test(String(wife.answer)), JSON.stringify(wife));
});

test("answer: a relative's attributes, diet, vehicle fates, friends and moves parse, typed any way", () => {
  const of = (who, rel) => ({ kind: "of", who, rel });
  const table = [
    ["what does my wife do", of({ kin: "wife" }, "role")],
    ["What does my wife do for a living?", of({ kin: "wife" }, "role")],
    ["wat does my wife do for work", of({ kin: "wife" }, "role")],
    ["whats my husbands job", of({ kin: "husband" }, "role")],
    ["what's my husband's occupation", of({ kin: "husband" }, "role")],
    ["what does jordan do", of({ name: "jordan" }, "role")],
    ["dani's job", of({ name: "dani" }, "role")],
    ["where does my mom live", of({ kin: "mom" }, "lives_in")],
    ["where does mum live now", of({ kin: "mum" }, "lives_in")],
    ["where is my brother based", of({ kin: "brother" }, "lives_in")],
    ["where does dani work", of({ name: "dani" }, "works_at")],
    ["who does my wife work for", of({ kin: "wife" }, "works_at")],
    ["where is my dad from", of({ kin: "dad" }, "from")],
    ["what breed is my dog", of({ kin: "dog" }, "breed")],
    ["what kind of dog is biscuit", of({ name: "biscuit" }, "breed")],
    ["what type of dog do we have", of({ kin: "dog" }, "breed")],
    ["is my wife vegetarian", of({ kin: "wife" }, "diet")],
    ["what does my wife drive", of({ kin: "wife" }, "car")],
    ["what does my wife do for fun", of({ kin: "wife" }, "hobby")],
    ["what does my wife do on sundays", of({ kin: "wife" }, "other")],
    ["what colour is my truck", { kind: "car", before: null, color: true, qual: "truck" }],
    ["what electric car do i drive", { kind: "car", before: null, color: false, qual: "electric" }],
    ["what truck did i buy", { kind: "car", before: null, color: false, qual: "truck" }],
    ["do i own a van", { kind: "car", before: null, color: false, qual: "van" }],
    ["what car does theo drive", of({ name: "theo" }, "car")],
    ["which suv do i have", { kind: "car", before: null, color: false, qual: "suv" }],
    ["what did i drive before", { kind: "car", before: "then", color: false }],
    ["what happened to the outback", { kind: "carFate", car: "outback" }],
    ["do i still have the subaru", { kind: "carFate", car: "subaru" }],
    ["did we sell the volvo", { kind: "carFate", car: "volvo" }],
    ["what do i do for a living", { kind: "job" }],
    ["What do I do?", { kind: "job" }],
    ["whats my line of work", { kind: "job" }],
    ["what is my occupation", { kind: "job" }],
    ["where did we move to", { kind: "lives", before: null }],
    ["where did i move", { kind: "lives", before: null }],
    ["where did we move from", { kind: "lives", before: "then" }],
    ["am i vegetarian", { kind: "diet", asked: "vegetarian" }],
    ["Am I a vegan?", { kind: "diet", asked: "vegan" }],
    ["whats my diet", { kind: "diet", asked: null }],
    ["do i eat meat", { kind: "diet", asked: null }],
    ["who are my friends", { kind: "kin", word: "friends", role: "friend" }],
    ["who is theo", { kind: "who", name: "theo" }],
    ["what db gui do i use", { kind: "uses", cat: "db gui" }],
    ["which database client do i use", { kind: "uses", cat: "database client" }],
    ["what terminal multiplexer do i use", { kind: "uses", cat: "terminal multiplexer" }],
    ["what password manager do i use", { kind: "uses", cat: "password manager" }],
    ["whats my company called", { kind: "work" }],
    ["what's my llc", { kind: "work" }],
    ["my business name", { kind: "work" }],
  ];
  for (const [q, want] of table) {
    const got = /** @type {any} */ (parse(String(q)));
    // "who are my friends" parses the same whether or not extract.js's KIN has friend words.
    if (got?.kind === "kin" && got.role === "friend") got.word = got.word.replace(/^friend$/, "friends");
    assert.deepEqual(got, want, String(q));
  }
});

/** A world of personal facts seeded as claims, each [subj, rel, obj], one turn apiece, in order. */
async function factWorld(t, claims) {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  const personal = new Personal(db);
  claims.forEach(([subj, rel, obj], i) => personal.addClaims(`s${i}`, 0, T0 + i * DAY, [{ subj, rel, obj, conf: 0.9, method: "rule" }]));
  personal.derive();
  const answer = answerer({ personal, db });
  return { personal, ask: async q => (await answer({ q })) };
}

const FAMILY = [
  ["me", "spouse", "kin:spouse"], ["kin:spouse", "called", "lit:wife"], ["kin:spouse", "name", "lit:Jordan"],
  ["kin:spouse", "role", "lit:nurse"], ["kin:spouse", "works_at", "org:Mercy Clinic"],
  ["me", "mother", "kin:mother"], ["kin:mother", "called", "lit:mom"], ["kin:mother", "lives_in", "place:Tucson"],
  ["me", "pet", "kin:dog"], ["kin:dog", "called", "lit:dog"], ["kin:dog", "name", "lit:Biscuit"], ["kin:dog", "breed", "lit:beagle"],
  ["me", "friend", "name:Theo"], ["me", "friend", "name:Dani"], ["name:Dani", "role", "lit:teacher"], ["name:Dani", "works_at", "org:Harbor School"],
  ["me", "sister", "name:Maya"], ["me", "sister", "name:Ana"], ["name:Maya", "lives_in", "place:Austin"],
  ["me", "diet", "lit:vegetarian"],
  ["me", "lives_in", "place:Portland"], ["me", "owns", "vehicle:Subaru Outback"], ["me", "role", "lit:designer"], ["me", "works_at", "org:Northwind Bakery"],
  ["me", "uses", "tool:TablePlus"], ["me", "uses", "tool:tmux"], ["me", "uses", "tool:Bitwarden"], ["me", "uses", "tool:Neovim"],
  ["me", "owns", "vehicle:Ford F-150"], ["vehicle:Ford F-150", "color", "lit:red"], ["me", "ended:owns", "vehicle:Subaru Outback"],
  ["me", "drives", "vehicle:Ford F-150"], ["me", "lives_in", "place:Seattle"], ["me", "lives_in", "place:Seattle"],
];

test("answer: a relative's or a named person's attribute, read on them and nobody else", async t => {
  const { ask } = await factWorld(t, FAMILY);
  const want = [
    ["what does my wife do", "Your wife is a nurse at Mercy Clinic."],
    ["what does my wfie do for a living", "Your wife is a nurse at Mercy Clinic."],
    ["whats my wife's job", "Your wife is a nurse at Mercy Clinic."],
    ["where does my wife work", "Your wife works at Mercy Clinic."],
    ["what does jordan do", "Jordan is a nurse at Mercy Clinic."],
    ["where does my mom live", "Your mom lives in Tucson."],
    ["where does mum live", "Your mum lives in Tucson."],
    ["what breed is my dog", "Biscuit is a beagle."],
    ["what kind of dog is biscuit", "Biscuit is a beagle."],
    ["where does dani work", "Dani works at Harbor School."],
    ["what does dani do", "Dani is a teacher at Harbor School."],
    ["where does maya live", "Maya lives in Austin."],
  ];
  for (const [q, a] of want) assert.equal((await ask(q)).answer, a, q);
  // Never the user's own fact, the relative's name, the wrong gender, or one of two sisters.
  for (const q of ["what does my husband do", "where does my dad live", "where does my wife live", "where does my sister live", "what breed is my cat",
    "what does theo do", "what does my wife do for fun", "is my wife vegetarian", "what does my wife drive", "where does my son work"]) {
    const r = await ask(q);
    assert.equal(r.answer, null, `${q} -> ${r.answer}`);
  }
});

test("answer: diet, vehicle fates, moves, jobs, friends and generic software", async t => {
  const { ask } = await factWorld(t, FAMILY);
  const want = [
    ["am i vegetarian", "Yes, you are vegetarian."],
    ["am i vegan", "You are vegetarian."],
    ["do i eat meat", "You are vegetarian."],
    ["whats my diet", "You are vegetarian."],
    ["what happened to the outback", "You sold the Subaru Outback."],
    ["do i still have the subaru", "You sold the Subaru Outback."],
    ["do i still have the ford", "You still have the Ford F-150."],
    ["what truck did i buy", "You drive a red Ford F-150."],
    ["what colour is my truck", "Your Ford F-150 is red."],
    ["what did i drive before", "Before the Ford F-150 you had a Subaru Outback."],
    ["where did we move to", "You live in Seattle."],
    ["where did i move", "You live in Seattle."],
    ["where did we move from", "Before Seattle you lived in Portland."],
    ["what do i do for a living", "You are a designer at Northwind Bakery."],
    ["whats my company called", "You work at Northwind Bakery."],
    ["whats my llc", "You work at Northwind Bakery."],
    ["who is theo", "Theo is your friend."],
    ["what db gui do i use", "You use TablePlus."],
    ["which terminal multiplexer do i use", "You use tmux."],
    ["what password manager do i use", "You use Bitwarden."],
    ["who is my partner", "Your partner is Jordan."],
  ];
  for (const [q, a] of want) assert.equal((await ask(q)).answer, a, q);
  assert.match(String((await ask("who are my friends")).answer), /^Your friends are (Theo and Dani|Dani and Theo)\.$/);
  // A vehicle memory never heard of has no fate.
  assert.equal((await ask("what happened to the tesla")).answer, null);
});

test("answer: no answer when only a name, or only the user's own fact, is known", async t => {
  const { ask, personal } = await factWorld(t, [
    ["me", "spouse", "kin:spouse"], ["kin:spouse", "called", "lit:wife"], ["kin:spouse", "name", "lit:Jordan"],
    ["me", "mother", "kin:mother"], ["kin:mother", "called", "lit:mom"], ["kin:mother", "name", "lit:Ruth"],
    ["me", "lives_in", "place:Tucson"], ["me", "role", "lit:designer"], ["me", "works_at", "org:Northwind Bakery"],
    ["me", "partner", "kin:partner"], ["kin:partner", "called", "lit:boyfriend"], ["kin:partner", "name", "lit:Sam"],
  ]);
  for (const q of ["what does my wife do", "whats my wife's job", "where does my wife work", "where does my mom live", "where does ruth live",
    "what does jordan do", "what breed is my dog", "who are my friends", "am i vegetarian", "what happened to the outback"]) {
    const r = await ask(q);
    assert.equal(r.answer, null, `${q} -> ${r.answer}`);
  }
  // A line told outright that only names the wife never answers what she does.
  personal.remember("My wife Jordan loves hiking on weekends.");
  assert.equal((await ask("what does my wife do")).answer, null);
  // A boyfriend is a partner, not a husband.
  assert.equal((await ask("who is my husband")).answer, null);
});
