// @ts-check
// Memory against the fictional corpus, plus a few fictional sessions of its own.
//
// What this is aimed at, in order of how quietly each one fails:
//  - A pass that is not idempotent. It does not error; the graph just grows every run. The
//    prototype had it twice (a NULL in a UNIQUE key, a clock fallback), and each has a test.
//  - The wrong employer. A hub session, a tool, or the user's own studio outvoting the real
//    client. Each has a world built so the naive answer is wrong.
//  - Evidence that points at the wrong turn, or at a turn that no longer exists.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../store/index.js";
import { SESSIONS, HOME, seedRecall } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";
import { Curator } from "./curator.js";
import { Graph } from "./graph.js";
import { extract } from "./extract.js";

const T0 = Date.parse("2026-09-01T09:00:00Z");
const DAY = 86_400_000;
const ME = { domains: ["riverastudio.com"], emails: ["alex@riverastudio.com"] };

function world(t, { sessions = SESSIONS, me = ME, recall = true } = {}) {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  if (recall) seedRecall(db, sessions);
  const curator = new Curator(db, { me });
  const graph = new Graph(db, curator);
  return { db, curator, graph, add: list => seedRecall(db, list) };
}

let n = 0;
/** A fictional session: strings are user turns. */
const S = (turns, { start = T0 + 10 * DAY, dir = "misc", name } = {}) => ({
  id: `22222222-bbbb-4000-8000-${String(++n).padStart(12, "0")}`, cwd: `${HOME}/Work/${dir}`, start, name,
  turns: turns.map(x => (typeof x === "string" ? { role: /** @type {"user"} */ ("user"), text: x } : x)),
});

const fid = (a, rel, b) => `${a}|${rel}|${b}`;
const DANA = "name:Dana Reyes", HARLOW = "name:Harlow Legal", SAM = "name:Sam Okafor", NORTHWIND = "name:Northwind Bakery";

const open_ = (db, src, rel) => db.prepare("SELECT dst, valid_from, valid_to FROM memory_edges WHERE src = ? AND rel = ? AND valid_to IS NULL").all(src, rel);
const dump = db => ({
  nodes: db.prepare("SELECT id, kind, role, sessions, mentions, first_seen, last_seen FROM memory_nodes ORDER BY id").all(),
  edges: db.prepare("SELECT src, rel, dst, weight, valid_from, valid_to, confidence FROM memory_edges ORDER BY src, rel, dst, valid_from").all(),
  evidence: db.prepare("SELECT e.src, e.rel, e.dst, v.session, v.seq FROM memory_evidence v JOIN memory_edges e ON e.id = v.edge ORDER BY 1, 2, 3, 4, 5").all(),
  forms: db.prepare("SELECT node, form, precision, sessions FROM memory_shortforms ORDER BY node, form").all(),
});

// ------------------------------------------------------------------ extract

test("memory: extract is pure and never throws on odd input", () => {
  const text = "Dana Reyes (dana@harlowlegal.com) asked for the intake form on harlowlegal.com";
  assert.deepEqual(extract(text), extract(text));
  for (const x of ["", null, undefined, 42, {}]) assert.deepEqual(extract(x), { things: [], cues: [] });
});

test("memory: extract finds addresses, domains, repos, names and the phrasings that link them", () => {
  const ids = t => extract(t).things.map(x => x.id);
  assert.ok(ids("write to Dana.Reyes@HarlowLegal.com today").includes("email:dana.reyes@harlowlegal.com"));
  assert.ok(ids("the page at https://app.harlowlegal.com/intake is live").includes("domain:harlowlegal.com"));
  assert.ok(ids("see northwindbakery.com.").includes("domain:northwindbakery.com"));
  assert.ok(ids("cloned github.com/rivera-studio/harlow-site.git last night").includes("repo:rivera-studio/harlow-site"));
  assert.ok(ids("I read the repo rivera-studio/harlow-site first").includes("repo:rivera-studio/harlow-site"));
  // Code is full of dotted names that are not domains, and example domains are nobody's.
  assert.deepEqual(ids("db.run(ctx.store) then intake.tsx and user@example.com"), []);
  const cue = extract("Dana Reyes, the office manager at Harlow Legal, and Sam Okafor (sam@northwindbakery.com) called").cues;
  assert.deepEqual(cue, [
    { rel: "email_of", a: SAM, b: "email:sam@northwindbakery.com" },
    { rel: "works_at", a: DANA, b: HARLOW },
  ].sort((x, y) => x.rel.localeCompare(y.rel)));
});

test("memory: a capital at the start of a sentence, a heading or a tool is not a name", () => {
  const names = t => extract(t).things.filter(x => x.kind === "name").map(x => x.key);
  for (const t of ["Perfect Timing Today, that landed.", "## Next Steps\n", "Key Findings follow.", "ok, Actually Seems Fine",
    "we moved it to Google Drive and Slack Connect", "sure, The Next Thing is ready"]) {
    assert.deepEqual(names(t), [], `${JSON.stringify(t)} produced a name`);
  }
  assert.deepEqual(names("ok, Actually Dana Reyes said so"), ["Dana Reyes"], "stripping an opener must keep the name after it");
  const initial = extract("Sam Okafor sends invoices.").things.find(x => x.kind === "name");
  assert.equal(initial?.initial, true);
  assert.equal(extract("Actually Dana Reyes called.").things.find(x => x.kind === "name")?.initial, true, "an opener at the start still makes the run sentence-initial");
  assert.equal(extract("we asked Sam Okafor.").things.find(x => x.kind === "name")?.initial, false);
});

// ------------------------------------------------------------------ the corpus

test("memory: against the corpus, people link to their organisations, domains and addresses", async t => {
  const { db, curator, graph } = world(t);
  const r = await curator.curate();
  assert.equal(r.recall, true);
  assert.ok(r.nodes > 0 && r.edges > 0);
  const node = id => db.prepare("SELECT kind, role FROM memory_nodes WHERE id = ?").get(id);
  assert.equal(node(DANA)?.kind, "person");
  assert.equal(node(SAM)?.kind, "person");
  assert.equal(node(HARLOW)?.kind, "org");
  assert.equal(node(NORTHWIND)?.kind, "org");
  assert.deepEqual(open_(db, DANA, "works_at").map(e => e.dst), [HARLOW]);
  assert.deepEqual(open_(db, SAM, "works_at").map(e => e.dst), [NORTHWIND]);
  assert.deepEqual(open_(db, DANA, "has_email").map(e => e.dst), ["email:dana@harlowlegal.com"]);
  assert.deepEqual(open_(db, HARLOW, "has_domain").map(e => e.dst), ["domain:harlowlegal.com"]);
  assert.deepEqual(open_(db, NORTHWIND, "has_domain").map(e => e.dst), ["domain:northwindbakery.com"]);
  // The repo lives under the user's own studio; config.me says whose that is.
  assert.equal(node("repo:rivera-studio/harlow-site")?.role, "own");

  const about = graph.facts({ about: "Harlow" });
  assert.equal(about.about?.id, HARLOW, "the short form should resolve to the firm");
  const texts = about.facts.map(f => f.text);
  assert.ok(texts.includes("Dana Reyes works at Harlow Legal"), texts.join("\n"));
  assert.ok(texts.includes("Harlow Legal's domain is harlowlegal.com"));
});

test("memory: \"Harlow\" is learned as a short form by measuring it, and a vaguer one is refused", async t => {
  const { db, curator } = world(t);
  await curator.curate();
  const form = f => db.prepare("SELECT node, precision, sessions FROM memory_shortforms WHERE form = ?").get(f);
  assert.equal(form("harlow")?.node, HARLOW);
  assert.equal(form("harlow")?.precision, 1, "every session saying Harlow is about the firm, through its name, domain or address");
  assert.equal(form("northwind")?.node, NORTHWIND);
  // "Sam" is said in two sessions and only one is about Sam Okafor by name or address.
  assert.ok(Number(form("sam")?.precision) < 0.6, "an imprecise short form must measure below the floor");
});

test("memory: every fact has a working why that points at a turn saying it", async t => {
  const { curator, graph } = world(t);
  await curator.curate();
  const facts = [...graph.facts({ limit: 200 }).facts];
  for (const a of ["Harlow Legal", "Northwind Bakery", "Dana Reyes", "Sam Okafor", "dana@harlowlegal.com", "rivera-studio/harlow-site"]) {
    facts.push(...graph.facts({ about: a, limit: 200 }).facts);
  }
  assert.ok(facts.length >= 10, "the corpus should yield facts: " + facts.length);
  for (const f of facts) {
    assert.ok(f.source && f.age !== undefined && typeof f.confidence === "number", `fact without source, age or confidence: ${f.id}`);
    const w = graph.why({ fact: f.id });
    assert.ok(w.turns.length > 0, `no supporting turn for ${f.id}`);
    assert.equal(w.gone, 0);
    const words = [f.subject.label, f.object.label].map(s => String(s).toLowerCase().split(/[\s@]/)[0]);
    assert.ok(w.turns.some(x => words.some(k => x.text.toLowerCase().includes(k))), `the turns behind ${f.id} do not mention it`);
  }
  // Evidence is by (session, seq): the address fact points at exactly the turns that wrote it.
  const w = graph.why({ fact: fid(DANA, "has_email", "email:dana@harlowlegal.com") });
  assert.ok(w.turns.some(x => x.session === SESSIONS[0].id && x.seq === 0));
});

// ------------------------------------------------------------------ who works where

test("memory: a hub session naming one organisation many times does not decide who works where", async t => {
  // On raw counts Northwind wins (eight mentions against three). By focus, the two sessions
  // about Harlow each give it a whole vote and the planning session only a share.
  const { db, curator } = world(t, { sessions: [
    S(["we sent the draft to Dana Reyes (dana.reyes@gmail.com) and Harlow Legal signed off"]),
    S(["the call with Dana Reyes about Harlow Legal went fine"]),
    S(["weekly: Dana Reyes joined. We covered Northwind Bakery menus, Northwind Bakery invoices, Northwind Bakery hours, " +
       "the Northwind Bakery site, Northwind Bakery photos, Northwind Bakery reviews, Northwind Bakery staff and Northwind Bakery " +
       "tax, then Pinecrest Dental, Lakeside Realty and Harlow Legal."]),
  ] });
  await curator.curate();
  assert.deepEqual(open_(db, DANA, "works_at").map(e => e.dst), [HARLOW]);
  // A free-mail address says nothing about an employer.
  assert.equal(db.prepare("SELECT role FROM memory_nodes WHERE id = 'domain:gmail.com'").get()?.role, "mail");
});

test("memory: tools and vendors get no vote, and an organisation in nearly every session is a hub", async t => {
  const sessions = [];
  for (let i = 0; i < 10; i++) sessions.push(S([`we reconciled payroll with Summit Payroll Services and pushed to github.com/rivera-studio/tools-${i} from Google Drive` +
    (i < 3 ? `; Dana Reyes (dana@harlowlegal.com) reviewed it${i < 2 ? " for Harlow Legal" : ""}` : "")]));
  const { db, curator } = world(t, { sessions });
  await curator.curate();
  const role = id => db.prepare("SELECT role FROM memory_nodes WHERE id = ?").get(id)?.role;
  assert.equal(role("name:Summit Payroll Services"), "hub");
  assert.equal(role("domain:github.com"), "tool");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM memory_nodes WHERE label LIKE '%Google%'").get()?.n, 0, "a tool became a node");
  assert.deepEqual(open_(db, DANA, "works_at").map(e => e.dst), [HARLOW]);
});

test("memory: the user's own studio is never taken for a client once config.me names it", async t => {
  const sessions = [1, 2, 3].map(i => S([`Rivera Studio sent Dana Reyes the proposal ${i}. Rivera Studio will follow up; Rivera Studio invoices monthly. ` +
    `Signed alex@riverastudio.com.`, `Dana Reyes (dana.reyes@gmail.com) forwarded it to Harlow Legal.`]));
  // Without config.me the studio outvotes the client: this is the failure being guarded.
  const naive = world(t, { sessions, me: {} });
  await naive.curator.curate();
  assert.deepEqual(open_(naive.db, DANA, "works_at").map(e => e.dst), ["name:Rivera Studio"], "the fixture must fool a curator that does not know who the user is");

  const { db, curator, graph } = world(t, { sessions, me: ME });
  await curator.curate();
  assert.equal(db.prepare("SELECT role FROM memory_nodes WHERE id = 'name:Rivera Studio'").get()?.role, "own");
  assert.equal(db.prepare("SELECT role FROM memory_nodes WHERE id = 'email:alex@riverastudio.com'").get()?.role, "own");
  assert.deepEqual(open_(db, DANA, "works_at").map(e => e.dst), [HARLOW]);
  assert.deepEqual(graph.relevant({ text: "send the Rivera Studio proposal again" }), [], "the user's own studio is not something to remind them of");
  assert.ok(!graph.facts({}).facts.some(f => f.subject.role === "own"), "the user's own studio is listed among outside parties");
});

test("memory: a move is bi-temporal: the old employer's edge closes where the new one starts", async t => {
  const { db, curator, graph, add } = world(t);
  await curator.curate();
  assert.deepEqual(open_(db, DANA, "works_at").map(e => e.dst), [HARLOW]);
  const later = [1, 2, 3, 4].map(i => S([`Dana Reyes at Northwind Bakery sent over batch ${i}; reach her at Dana Reyes (dana@northwindbakery.com).`],
    { start: T0 + (20 + i) * DAY }));
  add(later);
  await curator.curate();
  const all = db.prepare("SELECT dst, valid_from, valid_to FROM memory_edges WHERE src = ? AND rel = 'works_at' ORDER BY valid_from").all(DANA);
  assert.equal(all.length, 2, JSON.stringify(all));
  const [was, now] = all;
  assert.equal(was.dst, HARLOW);
  assert.equal(now.dst, NORTHWIND);
  assert.equal(now.valid_to, null);
  assert.equal(now.valid_from, T0 + 21 * DAY, "the new edge starts at the first session that put her there");
  assert.equal(was.valid_to, now.valid_from, "the old edge closes where the new one starts; it is not deleted");
  const facts = graph.facts({ about: "Dana Reyes" }).facts.filter(f => f.rel === "works_at");
  assert.deepEqual(facts.map(f => [f.object.label, f.until === null]), [["Northwind Bakery", true], ["Harlow Legal", false]]);
  // Idempotent across the move too.
  const before = dump(db);
  assert.equal((await curator.curate({ force: true })).changed, 0);
  assert.deepEqual(dump(db), before);
});

// ------------------------------------------------------------------ idempotency and increments

test("memory: three passes leave an identical graph, and the second changes nothing", async t => {
  const { db, curator } = world(t);
  const one = await curator.curate();
  const a = dump(db);
  const two = await curator.curate();
  assert.equal(two.changed, 0, "a pass over nothing new wrote something");
  assert.equal(await curator.derive(), 0, "deriving again from the same observations wrote something");
  const b = dump(db);
  await curator.curate({ full: true });
  const c = dump(db);
  assert.ok(one.changed > 0);
  assert.deepEqual(b, a);
  assert.deepEqual(c, a, "re-reading every turn changed the graph");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM memory_edges WHERE valid_from IS NULL").get()?.n, 0);
  // The constraint itself: a NULL valid_from is what let duplicates in, so it cannot be written.
  assert.throws(() => db.prepare("INSERT INTO memory_edges (src, rel, dst, valid_from, observed) VALUES ('a','b','c',NULL,1)").run(), /NOT NULL/);
});

test("memory: sessions with no start time do not grow the graph on re-run", async t => {
  const broken = [S(["forwarded to Dana Reyes (dana@harlowlegal.com) again"]), S(["Dana Reyes (dana@harlowlegal.com) replied"])];
  const { db, curator } = world(t, { sessions: [...SESSIONS, ...broken] });
  db.prepare("UPDATE recall_sessions SET started = NULL WHERE id = ?").run(broken[0].id);
  db.prepare("UPDATE recall_sessions SET started = 0 WHERE id = ?").run(broken[1].id);
  await curator.curate();
  const a = dump(db);
  const froms = db.prepare("SELECT valid_from FROM memory_edges WHERE dst IN (?, ?)").all("session:" + broken[0].id, "session:" + broken[1].id);
  assert.ok(froms.length >= 2 && froms.every(r => r.valid_from === 0), "an unknown start must be 0, never the clock");
  await curator.curate({ force: true }); await curator.curate({ force: true });
  assert.deepEqual(dump(db), a);
});

test("memory: reading a transcript turn by turn gives the same graph as reading it at once", async t => {
  const whole = world(t);
  await whole.curator.curate();
  // The same corpus, first half of each session, then the rest appended as Recall would.
  const half = SESSIONS.map(s => ({ ...s, turns: s.turns.slice(0, Math.ceil(s.turns.length / 2)) }));
  const inc = world(t, { sessions: half });
  await inc.curator.curate();
  const addT = inc.db.prepare("INSERT INTO recall_turns (session, seq, role, ts, text) VALUES (?,?,?,?,?)");
  for (const s of SESSIONS) {
    s.turns.forEach((x, seq) => { if (seq >= Math.ceil(s.turns.length / 2)) addT.run(s.id, seq, x.role, s.start + seq * 60_000, x.text); });
    inc.db.prepare("UPDATE recall_sessions SET turns = ?, ended = ? WHERE id = ?").run(s.turns.length, s.start + (s.turns.length - 1) * 60_000, s.id);
  }
  const r = await inc.curator.curate();
  assert.equal(r.turns, SESSIONS.reduce((n, s) => n + s.turns.length - Math.ceil(s.turns.length / 2), 0), "only the new turns should be read");
  assert.deepEqual(dump(inc.db), dump(whole.db));
});

test("memory: a rewritten transcript drops that session's evidence, and a missing turn reads as gone", async t => {
  const { db, curator, graph } = world(t);
  await curator.curate();
  const first = SESSIONS[0];
  // Compaction: Recall re-indexes the session from scratch and its seq values restart.
  db.prepare("DELETE FROM recall_turns WHERE session = ?").run(first.id);
  db.prepare("INSERT INTO recall_turns (session, seq, role, ts, text) VALUES (?,?,?,?,?)").run(first.id, 0, "user", T0, "Summary so far: the hero section is finished.");
  db.prepare("UPDATE recall_sessions SET turns = 1 WHERE id = ?").run(first.id);
  curator.reset(first.id);
  await curator.curate();
  assert.deepEqual(db.prepare("SELECT seq FROM memory_evidence WHERE session = ?").all(first.id), [], "evidence from the old transcript survived");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM memory_nodes WHERE id = ?").get(DANA)?.n, 0, "Dana Reyes was only named in the rewritten turns");
  assert.ok(db.prepare("SELECT COUNT(*) n FROM memory_nodes WHERE id = 'email:dana@harlowlegal.com'").get()?.n, "the address is still in another session");
  // A turn vanishing without anyone saying so: why() counts it as gone and does not throw.
  const f = fid(NORTHWIND, "has_domain", "domain:northwindbakery.com");
  const before = graph.why({ fact: f });
  assert.ok(before.turns.length > 0);
  db.prepare("DELETE FROM recall_turns WHERE session = ?").run(SESSIONS[2].id);
  const after = graph.why({ fact: f });
  assert.ok(after.gone > 0, "a missing turn should count as gone");
  assert.ok(after.turns.every(x => x.session !== SESSIONS[2].id));
});

test("memory: with no Recall tables there is nothing to curate, and nothing fails", async t => {
  const { curator, graph } = world(t, { recall: false });
  const r = await curator.curate();
  assert.equal(r.recall, false);
  assert.equal(r.nodes, 0);
  assert.deepEqual(graph.relevant({ text: "Harlow Legal" }), []);
  assert.deepEqual(graph.facts({}), { about: null, facts: [] });
  assert.equal(graph.stats().recall, false);
  assert.deepEqual(graph.why({ fact: "anything" }), { fact: null, turns: [], gone: 0 });
});

// ------------------------------------------------------------------ relevant, facts, steering

test("memory: relevant returns the few facts a prompt names, [] otherwise, and is fast", async t => {
  const { curator, graph } = world(t);
  await curator.curate();
  const r = graph.relevant({ text: "Can you check the Harlow intake form again?" });
  assert.ok(r.length > 0 && r.length <= 5);
  assert.ok(r.every(f => f.text.includes("Harlow Legal")), r.map(f => f.text).join("\n"));
  assert.ok(r.every(f => f.source && f.age && f.confidence > 0), "each fact carries source, age and confidence");
  // The shape the Enrich hook reads: a readable source label and an age in words.
  const h = graph.relevant({ text: "ask Sam Okafor" })[0];
  assert.equal(h.source, "Northwind invoices", "source should be the thread's /rename name");
  assert.match(h.age, /^\d+ (minute|hour|day|week|month|year)s?$/);
  assert.deepEqual(Object.keys(h.ref), ["session", "seq", "name"]);
  assert.deepEqual(graph.relevant({ text: "What's a good way to cache this function?" }), []);
  assert.deepEqual(graph.relevant({ text: "" }), []);
  // An address names its owner.
  assert.ok(graph.relevant({ text: "reply to dana@harlowlegal.com please" }).some(f => f.text === "Dana Reyes's email is dana@harlowlegal.com"));
  // A full name beats a short form of something else.
  assert.equal(graph.relevant({ text: "ask Sam Okafor" })[0]?.text, "Sam Okafor works at Northwind Bakery");
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) graph.relevant({ text: "the Northwind invoices and the Harlow site for Dana" });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 200;
  assert.ok(ms < 20, `relevant took ${ms.toFixed(2)}ms per call`);
});

test("memory: facts scoped to a project's folders name that project's people, not the others'", async t => {
  const { curator, graph } = world(t);
  await curator.curate();
  const harlow = graph.facts({ project_cwds: [`${HOME}/Work/harlow-site`, `${HOME}/Work/harlow-intake`] }).facts.map(f => f.text);
  assert.ok(harlow.includes("Dana Reyes works at Harlow Legal"), harlow.join("\n"));
  assert.ok(!harlow.some(x => x.includes("Northwind") || x.includes("Sam Okafor")), harlow.join("\n"));
  const northwind = graph.facts({ project_cwds: [`${HOME}/Work/northwind/`] }).facts.map(f => f.text);
  assert.ok(northwind.includes("Sam Okafor works at Northwind Bakery"), northwind.join("\n"));
  assert.ok(!northwind.some(x => x.includes("Dana")));
  assert.deepEqual(graph.facts({ project_cwds: [`${HOME}/Elsewhere`] }).facts, []);
});

test("memory: pin ranks a thing first in its scope, mute removes it, and both come off", async t => {
  const { curator, graph } = world(t);
  await curator.curate();
  const scope = `${HOME}/Work/northwind`;
  graph.steer({ node: "Dana Reyes", mode: "pin", scope });
  const top = f => f.facts[0]?.subject.label;
  assert.equal(top(graph.facts({ project_cwds: [scope] })), "Sam Okafor", "a pin must not add an unrelated thing to a project");
  assert.notEqual(top(graph.facts({ project_cwds: [`${HOME}/Work`] })), "Dana Reyes", "a pin leaked out of its scope");
  graph.steer({ node: "Dana Reyes", mode: "pin" });
  assert.equal(top(graph.facts({})), "Dana Reyes");
  graph.steer({ node: "Harlow", mode: "mute" });
  assert.equal(graph.facts({ about: "Harlow Legal" }).about?.muted, true);
  assert.ok(!graph.relevant({ text: "the Harlow site" }).some(f => f.text.includes("Harlow Legal")), "a muted thing was offered");
  assert.ok(!graph.facts({}).facts.some(f => f.text.includes("Harlow Legal")));
  graph.steer({ node: "Harlow", mode: "mute", off: true });
  assert.ok(graph.relevant({ text: "the Harlow site" }).length > 0);
  assert.throws(() => graph.steer({ node: "Nobody At All", mode: "pin" }), /nothing in memory/);
});

test("memory: stats count what is there", async t => {
  const { curator, graph } = world(t);
  await curator.curate();
  const s = graph.stats();
  assert.equal(s.recall, true);
  assert.equal(s.sessions, SESSIONS.length);
  assert.ok(s.facts > 0 && s.evidence > 0 && s.shortforms >= 2);
  assert.equal(s.byKind.person, 2);
  assert.ok(s.lastRun && s.lastRun.nodes === s.nodes);
});
