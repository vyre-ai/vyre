import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createMessageIndex, snippetOf } from "./message-index.js";

const seed = () => {
  const ix = createMessageIndex();
  ix.index("c1", [{ id: "u:1", who: "Dana", text: "Can you send the lease for Park Lane?" }, { id: "a:2", who: "Kit", text: "Sending the Park Lane lease now." }]);
  ix.index("c2", [{ id: "u:9", who: "Sam", text: "Lunch on Friday?" }, { id: "u:10", who: "Sam", text: "The parking lease is signed." }]);
  return ix;
};

test("a message is found when it holds every word, a word may be the start of a longer one, and the phrase ranks first", () => {
  const ix = seed();
  assert.deepEqual(ix.search("park lane lease").map(h => h.id), ["a:2", "u:1"], "both hold all three words; the later message ranks above the earlier");
  assert.deepEqual(ix.search("lease").map(h => h.chat).sort(), ["c1", "c1", "c2"]);
  assert.deepEqual(ix.search("park").map(h => h.id).sort(), ["a:2", "u:1", "u:10"], "parking starts with park");
  assert.deepEqual(ix.search("zzz"), []);
  assert.deepEqual(ix.search("   "), []);
});

test("whole words rank above a start of a word, and from: and chat narrow it", () => {
  const ix = seed();
  assert.equal(ix.search("park")[0].id !== "u:10", true, "parking is the weakest match");
  assert.deepEqual(ix.search("lease", { from: "sam" }).map(h => h.id), ["u:10"]);
  assert.deepEqual(ix.search("lease", { chat: "c1" }).map(h => h.chat), ["c1", "c1"]);
  assert.equal(ix.search("lease", { limit: 1 }).length, 1);
});

test("a snippet is a short piece around the match with the words marked", () => {
  assert.equal(snippetOf("Can you send the lease for Park Lane?", ["lease"]), "Can you send the «lease» for Park Lane?");
  const long = "x ".repeat(100) + "needle " + "y ".repeat(100);
  const s = snippetOf(long, ["needle"]);
  assert.ok(s.includes("«needle»") && s.startsWith("…") && s.endsWith("…") && s.length < 170);
});

test("leaving a chat drops its messages, locking clears everything, and indexing again changes nothing", () => {
  const ix = seed();
  const before = ix.size();
  ix.index("c1", [{ id: "u:1", who: "Dana", text: "Can you send the lease for Park Lane?" }, { id: "a:2", who: "Kit", text: "Sending the Park Lane lease now." }]);
  assert.equal(ix.size(), before, "the same messages twice are still the same messages");
  ix.drop("c1");
  assert.deepEqual(ix.search("lease").map(h => h.chat), ["c2"], "nothing of a chat the person left");
  ix.index("c1", [{ id: "u:1", who: "Dana", text: "Can you send the lease for Park Lane?" }]);
  assert.equal(ix.held("c1"), true);
  assert.deepEqual(ix.search("lease").map(h => h.chat), ["c2"], "a later frame cannot put a removal back");
  ix.reopen("c1");
  ix.index("c1", [{ id: "u:1", who: "Dana", text: "Can you send the lease for Park Lane?" }]);
  assert.equal(ix.held("c1"), false);
  assert.ok(ix.search("lease").some(h => h.chat === "c1"), "back in once the chat says so");
  ix.drop("c1");
  ix.clear();
  assert.equal(ix.size(), 0);
  assert.equal(ix.held("c1"), false, "a lock lets the next session search");
  assert.deepEqual(ix.search("lease"), []);
  ix.index("c3", [{ id: "x", who: "", text: "   " }]);
  assert.equal(ix.size(), 0, "an empty message is not kept");
});

test("the index never writes or sends: no storage, no network, no module of the box in the file", () => {
  const src = fs.readFileSync(new URL("./message-index.js", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|WebSocket|import\s/);
});
