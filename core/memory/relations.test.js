// @ts-check
// Better resolution and new relations (docs/adr/0007-intelligence.md, decision 2), still with no
// model: local parts across sessions, word-like TLDs and org words in domains, one identity per
// address, middle initials; has_title, client_of, repo_for, deadline; prefers and decided behind
// a flag. Precision first: every test has a distractor. Fictional data only.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../store/index.js";
import { HOME, seedRecall } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";
import { Curator, dateOf } from "./curator.js";
import { Graph } from "./graph.js";
import { extract } from "./extract.js";

const T0 = Date.parse("2026-09-01T09:00:00Z");   // a Tuesday
const DAY = 86_400_000;
let n = 0;
/** A session: strings are user turns, { a: "..." } an assistant turn. */
const S = (turns, { start = T0, dir = "misc" } = {}) => ({
  id: `77777777-aaaa-4000-8000-${String(++n).padStart(12, "0")}`, cwd: `${HOME}/Work/${dir}`, start,
  turns: turns.map(x => (typeof x === "string" ? { role: /** @type {"user"} */ ("user"), text: x } : { role: /** @type {"assistant"} */ ("assistant"), text: x.a })),
});

async function world(t, sessions, { relations, now = T0 + 5 * DAY } = {}) {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, sessions);
  const curator = new Curator(db, { me: { domains: ["riverastudio.com"] }, relations });
  await curator.curate();
  let clock = now;
  return { db, curator, graph: new Graph(db, curator, { now: () => clock }), at: ms => { clock = ms; } };
}
const edges = (db, rel) => db.prepare("SELECT src, dst, confidence, rule FROM memory_edges WHERE room = '*' AND rel = ? AND valid_to IS NULL ORDER BY src, dst").all(rel);
const pairs = (db, rel) => edges(db, rel).map(e => [e.src, e.dst]);

test("resolution: an address matches a person across sessions only when one person fits and works there", async t => {
  const { db } = await world(t, [
    S(["Dana Reyes at Harlow Legal sent the lease; see harlowlegal.com."]),
    S(["Dana Reyes at Harlow Legal wants the intake form moved."]),
    // The address, alone: no name beside it in this session.
    S(["forward the draft to dana@harlowlegal.com today"]),
    // Two Sams at one firm: an address with that local part fits both, so it fits no one.
    S(["Sam Okafor at Northwind Bakery and Sam Lee at Northwind Bakery split the orders; see northwindbakery.com."]),
    S(["Sam Okafor at Northwind Bakery and Sam Lee at Northwind Bakery both approved."]),
    S(["send it to sam@northwindbakery.com"]),
  ]);
  const has = edges(db, "has_email");
  assert.deepEqual(has.map(e => [e.src, e.dst, e.confidence, e.rule]), [["name:Dana Reyes", "email:dana@harlowlegal.com", 0.75, "email_local_org"]]);
});

test("resolution: a word-like TLD or an organisation word in a domain spells the organisation", async t => {
  const { db } = await world(t, [
    S(["Harlow Law moved its site to harlow.law last week."]),
    S(["the Harlow Law intake is on harlow.law/intake."]),
    S(["Keel & Ash sent the drawings from keelasharchitects.com."]),
    S(["the Keel & Ash portfolio lives on keelasharchitects.com."]),
    // A plain TLD is not a word: this domain spells nobody here.
    S(["Brightline Group runs brightlinegroupcom.net and brightlinegroupcom.net again."]),
  ]);
  const hd = pairs(db, "has_domain");
  assert.ok(hd.some(([a, b]) => a === "name:Harlow Law" && b === "domain:harlow.law"), JSON.stringify(hd));
  assert.ok(hd.some(([a, b]) => a === "name:Keel & Ash" && b === "domain:keelasharchitects.com"), JSON.stringify(hd));
  assert.ok(!hd.some(([a]) => a === "name:Brightline Group"), JSON.stringify(hd));
});

test("resolution: two names with one address are one person, and a middle initial is no new name", async t => {
  const names = x => extract(x).things.filter(y => y.kind === "name").map(y => y.key);
  assert.deepEqual(names("we asked Dana M. Reyes for the lease"), ["Dana Reyes"]);
  assert.deepEqual(names("Plan A. Then we ship"), [], "a list letter is not a middle initial");
  const { db } = await world(t, [
    S(["Dana Reyes (dana@harlowlegal.com) sent the lease."]),
    S(["Dana Marie Reyes (dana@harlowlegal.com) signed it."]),
    // One shared inbox, two different people: no shared word, so not one person.
    S(["Sam Okafor (orders@northwindbakery.com) and Lena Park (orders@northwindbakery.com) share it."]),
  ]);
  const node = id => db.prepare("SELECT id FROM memory_nodes WHERE id = ?").get(id);
  assert.ok(node("name:Dana Reyes"));
  assert.equal(node("name:Dana Marie Reyes"), undefined, "the longer spelling should pool into the shorter");
  assert.ok(node("name:Sam Okafor") && node("name:Lena Park"), "a shared inbox is not one person");
});

test("relations: has_title from the appositive, one per person, and not from a clause", async t => {
  const { db, graph } = await world(t, [
    S(["Dana Reyes, the office manager at Harlow Legal, signed off."]),
    S([{ a: "Sent it to Dana Reyes, the office manager at Harlow Legal." }]),
    S(["Sam Okafor, who works at Northwind Bakery, called twice. Sam Okafor, currently at Northwind Bakery, wrote."]),
  ]);
  assert.deepEqual(pairs(db, "has_title"), [["name:Dana Reyes", "title:office manager"]]);
  assert.ok(graph.facts({ about: "Dana Reyes" }).facts.some(f => f.text === "Dana Reyes is the office manager"));
  assert.ok(graph.relevant({ text: "ask Dana Reyes" }).some(f => f.text === "Dana Reyes is the office manager"));
  assert.deepEqual(graph.relevant({ text: "who is the office manager here?" }), [], "a title is not a name a prompt can call up");
});

test("relations: client_of from the user's own words, never from code talk or Claude's", async t => {
  const { db, graph } = await world(t, [
    S(["Northwind Bakery is a new client, so add them to the list and set up northwindbakery.com."]),
    S(["Keel & Ash Architects are our new client; they want a portfolio."]),
    S([{ a: "Summit Dental is a new client too, I assume." }, "no, Summit Dental is just a logo on the page"]),
    S(["The API client retries twice. Make the HTTP client time out after 5 seconds."]),
  ]);
  assert.deepEqual(pairs(db, "client_of"), [["name:Keel & Ash Architects", "me:you"], ["name:Northwind Bakery", "me:you"]]);
  assert.ok(graph.facts({ about: "Northwind Bakery" }).facts.some(f => f.text === "Northwind Bakery is your client"));
});

test("relations: repo_for when a repo is named after an organisation and they meet in two sessions", async t => {
  const { db } = await world(t, [
    S(["push the repo rivera-studio/harlow-site for Harlow Legal today"]),
    S(["the repo rivera-studio/harlow-site builds the Harlow Legal pages"]),
    // Named after it, but seen together once: not enough.
    S(["cloned rivera-studio/northwind-menu while Northwind Bakery waited"]),
  ]);
  assert.deepEqual(pairs(db, "repo_for"), [["repo:rivera-studio/harlow-site", "name:Harlow Legal"]]);
  assert.deepEqual(pairs(db, "owned_by"), [], "the user's own repo is not owned by the client");
});

test("relations: a deadline is read against the turn's own time and closes two days after", async t => {
  assert.equal(dateOf("friday", T0), "2026-09-04");
  assert.equal(dateOf("tuesday", T0), "2026-09-01", "the same weekday is today");
  assert.equal(dateOf("18 september", T0), "2026-09-18");
  assert.equal(dateOf("oct 2", T0), "2026-10-02");
  assert.equal(dateOf("3 january", T0), "2027-01-03", "a date well past is next year's");
  assert.equal(dateOf("31 february", T0), null);
  assert.equal(dateOf("friday", 0), null, "no turn time, no guess");
  const { db, graph, at } = await world(t, [
    S(["Keel & Ash Architects launches on 2 October, so finish the gallery. Keel & Ash Architects wrote from keelash.studio."]),
    S(["Keel & Ash Architects sent photos from keelash.studio."]),
    S(["the Northwind Bakery menu ships Friday. Northwind Bakery confirmed on northwindbakery.com."], { start: T0 + DAY }),
    S(["Northwind Bakery sent prices from northwindbakery.com."]),
    // Code talk: "ship it Friday" names no deadline.
    S(["Make the HTTP client time out after 5 seconds, then ship it Friday."]),
  ]);
  assert.deepEqual(pairs(db, "deadline"), [["name:Keel & Ash Architects", "date:2026-10-02"], ["name:Northwind Bakery", "date:2026-09-04"]]);
  at(Date.parse("2026-09-05T12:00:00Z"));
  assert.ok(graph.relevant({ text: "what about Northwind Bakery?" }).some(f => f.text === "Northwind Bakery has a deadline on 2026-09-04"));
  at(Date.parse("2026-09-07T12:00:00Z"));
  assert.ok(!graph.relevant({ text: "what about Northwind Bakery?" }).some(f => f.rel === "deadline" || f.text.includes("deadline")), "a passed deadline stays out of a prompt");
  const f = graph.facts({ about: "Northwind Bakery" }).facts.find(x => x.rel === "deadline");
  assert.equal(f?.until, Date.parse("2026-09-06T00:00:00Z"), "listed, closed two days after its date");
});

test("relations: prefers and decided are off by default and read only from the user when on", async t => {
  const sessions = [
    S(["Sam Okafor (sam@northwindbakery.com) at Northwind Bakery asked again. Sam prefers invoices as PDF."], { dir: "northwind" }),
    S(["Sam Okafor at Northwind Bakery wrote. Sam prefers invoices as PDF."], { dir: "northwind" }),
    S([{ a: "Sam prefers email, I think." }], { dir: "northwind" }),
    S(["We decided to keep intake on one page."]),
    S(["The API client retries twice by default."]),
  ];
  const off = await world(t, sessions);
  assert.deepEqual(pairs(off.db, "prefers"), []);
  assert.deepEqual(pairs(off.db, "decided"), []);
  const on = await world(t, sessions, { relations: { prefers: true, decided: true } });
  const rooms = [{ slug: "northwind", name: "Northwind", folders: [`${HOME}/Work/northwind`], threads: [] }];
  on.curator.setRooms(rooms);
  await on.curator.curate();
  const prefers = on.db.prepare("SELECT src, dst FROM memory_edges WHERE room = 'northwind' AND rel = 'prefers'").all().map(e => [e.src, e.dst]);
  assert.deepEqual(prefers, [["name:Sam Okafor", "pref:invoices as pdf"]], "the short form resolves in the room where it is precise");
  assert.deepEqual(pairs(on.db, "decided"), [["me:you", "decision:keep intake on one page"]]);
  assert.ok(on.graph.facts({ about: "me:you" }).facts.some(f => f.text === "you decided to keep intake on one page"));
});

test("resolution: spellings sharing a domain are one identity, named by the longest, in the graph and in Enrich", async t => {
  const { db, graph } = await world(t, [
    S(["Keel & Ash Architects want a portfolio site. Priya Anand at Keel & Ash Architects wrote from p.anand@keelash.studio."]),
    S(["Started the Keel & Ash portfolio in github.com/keelash/portfolio-site; it deploys to keelash.studio."]),
    S(["Keel & Ash sent photos; push them to keelash.studio and github.com/keelash/portfolio-site."]),
    // A different firm with a different domain stays apart, whatever words it shares.
    S(["Summit Dental wrote from summitdental.com about the lease."]),
    S(["Summit Roofing wrote from summitroofing.com about the roof."]),
    S(["Summit Dental and Summit Roofing both sent logos."]),
  ]);
  const nodes = db.prepare("SELECT id FROM memory_nodes WHERE kind = 'org' ORDER BY id").all().map(r => r.id);
  assert.ok(nodes.includes("name:Keel & Ash Architects"), JSON.stringify(nodes));
  assert.ok(!nodes.includes("name:Keel & Ash"), "the shorter spelling is no node of its own: " + JSON.stringify(nodes));
  assert.ok(nodes.includes("name:Summit Dental") && nodes.includes("name:Summit Roofing"), JSON.stringify(nodes));
  assert.deepEqual(pairs(db, "has_domain").filter(([, d]) => d === "domain:keelash.studio"), [["name:Keel & Ash Architects", "domain:keelash.studio"]]);
  assert.deepEqual(pairs(db, "owned_by"), [["repo:keelash/portfolio-site", "name:Keel & Ash Architects"]]);
  // The shorter spelling still names it in a prompt, and each fact comes back once.
  const got = graph.relevant({ text: "Push the latest Keel & Ash changes to keelash.studio", limit: 10 });
  assert.ok(got.length, "the short spelling names the identity");
  assert.ok(got.every(f => !f.id.includes("name:Keel & Ash|") && !f.id.endsWith("|name:Keel & Ash")), JSON.stringify(got.map(f => f.id)));
  assert.equal(new Set(got.map(f => f.text)).size, got.length, "no fact twice");
  assert.equal(graph.resolve("Keel & Ash")?.id, "name:Keel & Ash Architects");
});
