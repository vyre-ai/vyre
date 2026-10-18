import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { parseQuery, score, bestMatch, actionHits, filterRows, SCOPE_LIST } from "./query.js";

test("filters are taken out of the line and the rest is what is searched", () => {
  assert.deepEqual(parseQuery("lease from:dana in:chats type:chat"), { text: "lease", scope: "chats", type: "chat", from: "dana", within: null });
  assert.deepEqual(parseQuery('budget in:"Park Lane" from:me'), { text: "budget", scope: null, type: null, from: "me", within: "Park Lane" });
  assert.deepEqual(parseQuery("in:settings"), { text: "", scope: "settings", type: null, from: null, within: null });
  assert.deepEqual(parseQuery("in:Everything"), { text: "", scope: "all", type: null, from: null, within: null });
});

test("a colon in an ordinary search is not a filter: an unknown type, an empty value, or no filter name", () => {
  assert.equal(parseQuery("note: call back").text, "note: call back");
  assert.equal(parseQuery("type:banana tax").text, "type:banana tax");
  assert.equal(parseQuery("from: dana").text, "from: dana");
  assert.equal(parseQuery("ratio 3:1").text, "ratio 3:1");
});

test("the scopes are Everything, Chats, People, Records, Projects, Files and Settings", () => {
  assert.deepEqual(SCOPE_LIST.map(s => s[1]), ["Everything", "Chats", "People", "Records", "Projects", "Files", "Settings"]);
});

test("a title match scores by how it starts, and the best match is the highest title match, never a body match", () => {
  const ws = ["park"];
  assert.equal(score("Park", ws), 100);
  assert.equal(score("Park Lane lease", ws), 80);
  assert.equal(score("Lease at Park Lane", ws), 60);
  assert.equal(score("Carpark", ws), 40);
  assert.equal(score("Lease", ws), 20);
  const secs = [{ key: "chats", label: "Chats", rows: [{ key: "a", title: "Lease at Park Lane" }, { key: "b", title: "Carpark rota" }] }, { key: "projects", label: "Projects", rows: [{ key: "c", title: "Park Lane" }, { key: "d", title: "Unrelated" }] }];
  const { best, rest } = bestMatch(secs, "park");
  assert.equal(best?.key, "c", "the starts-with title wins over the later word");
  assert.deepEqual(rest.map(s => s.rows.map(r => r.key)), [["a", "b"], ["d"]], "it is taken out of its own section");
  assert.equal(bestMatch([{ key: "x", label: "X", rows: [{ key: "y", title: "Nothing here" }] }], "park").best, null, "no title match, no best match");
});

test("actions match on every typed word, from the start of a word", () => {
  assert.deepEqual(actionHits("new fl").map(a => a.key), ["new-flow"]);
  assert.ok(actionHits("new").length === 3, "capped at three");
  assert.deepEqual(actionHits("zzz"), []);
  assert.deepEqual(actionHits(""), []);
});

test("type, from and in keep only the rows they name", () => {
  const rows = [
    { kind: "chat", title: "Lease", sub: "Dana, 2 h ago", where: "Park Lane" },
    { kind: "person", title: "Dana Reyes", sub: "dana@example.test" },
    { kind: "file", title: "lease.pdf", sub: "Park Lane files", from: "Sam" },
  ];
  assert.deepEqual(filterRows(rows, { type: "chat", from: null, within: null }).map(r => r.title), ["Lease"]);
  assert.deepEqual(filterRows(rows, { type: null, from: "sam", within: null }).map(r => r.title), ["lease.pdf"]);
  assert.deepEqual(filterRows(rows, { type: null, from: null, within: "park lane" }).map(r => r.title), ["Lease", "lease.pdf"]);
  assert.equal(filterRows(rows, { type: null, from: null, within: null }).length, 3);
});
