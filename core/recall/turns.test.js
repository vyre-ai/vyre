// @ts-check
// Turn links and verbatim spans: the indexer writes what each turn touched, recall.turn reads a past
// span word for word, and recall.links and a search narrowed by a file find turns by what they touched.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { MIGRATIONS } from "./schema.js";
import { Indexer } from "./indexer.js";
import { search } from "./search.js";
import { span, byLink, parsePointer, pointer, label, range, SPAN_TURNS } from "./turns.js";
import { CLIP } from "../transcripts/index.js";
import { tempHome } from "../../test/helpers.js";

const CWD = "/work/app";
let tick = 0;
const line = (type, message) => JSON.stringify({ type, cwd: CWD, timestamp: new Date(1e12 + ++tick * 1000).toISOString(), message });
const user = text => line("user", { role: "user", content: text });
const say = text => line("assistant", { role: "assistant", content: [{ type: "text", text }] });
const call = (id, name, input) => line("assistant", { role: "assistant", content: [{ type: "tool_use", id, name, input }] });
const done = (id, text) => line("user", { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] });

function setup(t) {
  const home = tempHome(t);
  const dir = path.join(home, "transcripts");
  fs.mkdirSync(path.join(dir, "-work-app"), { recursive: true });
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  migrate(db, "recall", MIGRATIONS);
  const ix = new Indexer(db, {});
  let bump = 0;
  const write = (id, lines) => {
    const file = path.join(dir, "-work-app", `${id}.jsonl`);
    fs.writeFileSync(file, lines.join("\n") + "\n");
    const when = new Date(Date.now() + ++bump * 5000);
    fs.utimesSync(file, when, when);
    return file;
  };
  return { db, ix, dir, write, index: () => ix.run([dir]), rows: (sql, ...a) => db.prepare(sql).all(...a) };
}

const SESSION = [
  user("fix the login bug in the auth module"),
  say("Looking at auth."),
  call("t1", "Read", { file_path: "/work/app/src/auth.ts" }),
  call("t2", "Edit", { file_path: "/work/app/src/auth.ts" }),
  done("t2", "ok"),
  call("t3", "Bash", { command: "git commit -am 'fix login'" }),
  done("t3", "[main c0ffee1] fix login"),
  say("Fixed the login bug and committed it."),
  user("now update the docs page"),
  call("t4", "Write", { file_path: "/work/app/docs/login.md" }),
  done("t4", "ok"),
  say("Docs updated, see https://example.com/guide for the template."),
];

test("recall: the indexer writes each turn's links, and a rewritten transcript replaces them", async t => {
  const e = setup(t);
  e.write("s1", SESSION);
  await e.index();
  const got = e.rows("SELECT seq, kind, ref FROM recall_links WHERE session = 's1' ORDER BY seq, kind, ref").map(r => `${r.seq} ${r.kind} ${r.ref}`);
  assert.deepEqual(got, ["2 commit c0ffee1", "2 file src/auth.ts", "2 read src/auth.ts", "4 file docs/login.md", "4 url https://example.com/guide"]);
  // Grown: the old links stay, the new turn's arrive.
  e.write("s1", [...SESSION, user("thanks"), say("Welcome. The final edit was commit 9f8e7d6.")]);
  await e.index();
  assert.equal(e.rows("SELECT COUNT(*) n FROM recall_links WHERE session = 's1'")[0].n, 6);
  assert.deepEqual(e.rows("SELECT ref FROM recall_links WHERE session = 's1' AND seq = 6").map(r => r.ref), ["9f8e7d6"]);
  // Rewritten (its first turn changed): the session's links are those of the new file alone.
  e.write("s1", [user("a different start"), say("Different answer touching nothing.")]);
  await e.index();
  assert.equal(e.rows("SELECT COUNT(*) n FROM recall_links WHERE session = 's1'")[0].n, 0);
});

test("recall: sessions indexed before links existed are linked once, then skipped again when unchanged", async t => {
  const e = setup(t);
  e.write("s1", SESSION);
  await e.index();
  // Make it look like an index from before the links table: no links, no meta mark.
  e.db.exec("DELETE FROM recall_links; DELETE FROM recall_meta WHERE k = 'links'");
  const later = new Indexer(e.db, {});
  assert.equal(later.linked, false);
  const s1 = await later.run([e.dir]);
  assert.equal(s1.skipped, 0, "the unchanged file was read once more for its links");
  assert.equal(s1.turns, 0, "no turn was written again");
  assert.equal(e.rows("SELECT COUNT(*) n FROM recall_links")[0].n, 5);
  assert.equal(later.linked, true);
  const s2 = await later.run([e.dir]);
  assert.equal(s2.skipped, 1);
  assert.equal(e.rows("SELECT COUNT(*) n FROM recall_turns WHERE session = 's1'")[0].n, 5);
});

test("recall: forgetting a session forgets its links", async t => {
  const e = setup(t);
  e.write("s1", SESSION);
  await e.index();
  assert.ok(e.rows("SELECT COUNT(*) n FROM recall_links")[0].n > 0);
  e.ix.forget(["s1"]);
  assert.equal(e.rows("SELECT COUNT(*) n FROM recall_links")[0].n, 0);
});

test("turns: a span is verbatim, in order, with pointers and links, and a prefix names the session", async t => {
  const e = setup(t);
  e.write("abcdef12-0000", SESSION);
  await e.index();
  const r = span(e.db, { session: "abcdef12", seq: 2, before: 1, after: 1 });
  assert.equal(r.session.id, "abcdef12-0000");
  assert.deepEqual(r.turns.map(x => x.seq), [1, 2, 3]);
  assert.equal(r.turns[0].text, "Looking at auth.");
  assert.equal(r.turns[1].pointer, "abcdef12-0000:2");
  assert.deepEqual(r.turns[1].links.map(l => `${l.kind}:${l.ref}`), ["commit:c0ffee1", "file:src/auth.ts", "read:src/auth.ts"]);
  assert.equal(r.turns[2].role, "user");
  assert.ok(r.turns.every(x => x.ts > 0));
  assert.equal(r.truncated, undefined);
  // from + span, and from + to
  assert.deepEqual(span(e.db, { session: "abcdef12-0000", from: 3, span: 2 }).turns.map(x => x.seq), [3, 4]);
  assert.deepEqual(span(e.db, { session: "abcdef12-0000", from: 3, to: 99 }).turns.map(x => x.seq), [3, 4], "past the end is just the end");
  assert.throws(() => span(e.db, { session: "abcdef12-0000" }), /name the turn/);
  assert.throws(() => span(e.db, { session: "nope", seq: 0 }), /no session nope/);
  assert.throws(() => range({ seq: -1 }), /turn number/);
});

test("turns: a turn the index cut is read whole from the transcript; if the file has changed under it, the cut text is given and says so", async t => {
  const e = setup(t);
  const long = "line ".repeat(1500) + "THE VERY END";
  const file = e.write("s2", [user("explain it all"), say(long), user("ok")]);
  await e.index();
  const stored = e.rows("SELECT text FROM recall_turns WHERE session = 's2' AND seq = 1")[0].text;
  assert.ok(stored.length <= CLIP + 10 && !stored.includes("THE VERY END"), "the index holds the first CLIP characters");
  const r = span(e.db, { session: "s2", seq: 1 });
  assert.ok(r.turns[0].text.endsWith("THE VERY END"), "verbatim: all of it");
  assert.equal(r.turns[0].cut, undefined);
  assert.equal(span(e.db, { session: "s2", seq: 1, full: false }).turns[0].text, stored);
  assert.equal(span(e.db, { session: "s2", seq: 1, full: false }).turns[0].cut, true);
  // The file now says other words at that seq: never splice them in.
  fs.writeFileSync(file, [user("explain it all"), say("something else " + "x ".repeat(3000)), user("ok")].join("\n") + "\n");
  const again = span(e.db, { session: "s2", seq: 1 });
  assert.equal(again.turns[0].text, stored);
  assert.equal(again.turns[0].cut, true);
  assert.match(again.note || "", /no longer matches/);
  // The file is gone: the stored text is what there is.
  fs.rmSync(file);
  assert.equal(span(e.db, { session: "s2", seq: 1 }).turns[0].text, stored);
});

test("turns: a span is at most SPAN_TURNS turns and says where to go on", async t => {
  const e = setup(t);
  const lines = [];
  for (let i = 0; i < SPAN_TURNS + 20; i++) lines.push(i % 2 ? say(`answer ${i}`) : user(`question ${i}`));
  e.write("s3", lines);
  await e.index();
  const r = span(e.db, { session: "s3", from: 0, to: 500 });
  assert.equal(r.turns.length, SPAN_TURNS);
  assert.equal(r.next, SPAN_TURNS);
  const more = span(e.db, { session: "s3", from: r.next, to: 500 });
  assert.equal(more.turns.length, 20);
  assert.equal(more.next, undefined);
});

test("turns: pointers round-trip, and a label is one scannable line", () => {
  assert.equal(pointer("a/agent-1", 7), "a/agent-1:7");
  assert.deepEqual(parsePointer("a/agent-1:7"), { session: "a/agent-1", seq: 7 });
  assert.equal(parsePointer("nonsense"), null);
  const l = label({ session: "s", seq: 3, role: "user", ts: Date.UTC(2026, 9, 5, 12, 30), text: "x".repeat(200) }, 20);
  assert.equal(l, "s:3 person 2026-10-05 12:30: " + "x".repeat(19) + "…");
});

test("links: a file is found by path or bare name, a commit by a short or full hash, and the rest stay out", async t => {
  const e = setup(t);
  e.write("s1", SESSION);
  e.write("s4", [user("other"), say("I edited the thing."), call("t9", "Edit", { file_path: "/work/app/src/other-auth.ts" }), done("t9", "ok"), say("done")]);
  await e.index();
  const byName = byLink(e.db, { ref: "auth.ts" });
  assert.deepEqual(byName.map(x => `${x.session}:${x.seq}`).sort(), ["s1:2"], "other-auth.ts is not auth.ts: a name matches whole path segments");
  assert.equal(byLink(e.db, { ref: "src/auth.ts", kind: "read" }).length, 1);
  assert.throws(() => byLink(e.db, { ref: "src/auth.ts", kind: "commit" }), /give ref/, "a commit filter does not read as a path");
  assert.equal(byLink(e.db, { ref: "c0ffee1", kind: "commit" })[0].pointer, "s1:2");
  assert.equal(byLink(e.db, { ref: "c0ffee1d9a8b7c6", kind: "commit" })[0].pointer, "s1:2", "a longer hash names the same commit as its short form");
  assert.equal(byLink(e.db, { ref: "c0ffee", kind: "commit" })[0].pointer, "s1:2", "and a shorter prefix finds it");
  assert.equal(byLink(e.db, { ref: "https://example.com/guide", kind: "url" })[0].pointer, "s1:4");
  assert.throws(() => byLink(e.db, { ref: "" }), /give ref/);
  assert.throws(() => byLink(e.db, { ref: "zz", kind: "commit" }), /give ref/);
  assert.equal(byLink(e.db, { ref: "100%_" }).length, 0, "LIKE wildcards are text");
});

test("search: links narrow a search to turns that touched a file, or sit next to one", async t => {
  const e = setup(t);
  e.write("s1", SESSION);
  e.write("s5", [user("fix the login bug somewhere else"), say("I fixed the login bug in the other service."), user("login"), say("login done")]);
  await e.index();
  const all = await search(e.db, { q: "login bug" });
  assert.ok(all.hits.some(h => h.session === "s5") && all.hits.some(h => h.session === "s1"));
  const narrow = await search(e.db, { q: "login bug", links: [{ kind: "file", ref: "auth.ts" }] });
  assert.ok(narrow.hits.length > 0);
  assert.ok(narrow.hits.every(h => h.session === "s1"), JSON.stringify(narrow.hits.map(h => [h.session, h.seq])));
  assert.deepEqual((await search(e.db, { q: "login bug", links: [{ kind: "file", ref: "nothing.ts" }] })).hits, []);
  const both = await search(e.db, { q: "login bug", links: [{ kind: "file", ref: "auth.ts" }, { kind: "commit", ref: "c0ffee1" }] });
  assert.ok(both.hits.length > 0);
  // An unusable filter does not narrow to nothing: it is ignored.
  assert.ok((await search(e.db, { q: "login bug", links: [{ ref: "" }] })).hits.length > 1);
});
