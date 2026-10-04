// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGroup, parseWho, authorLabel, avatarStack, unreadDivider, presenceLine, askAudience, fanoutKeep, textMentions, sealedNoteSeen, markSealedNoteSeen, sealedNoteText } from "./group.js";

const V = "person:alex";
let cur = 0;
/** @param {string} type @param {any} data @param {Record<string, any>} [top] */
const fr = (type, data, top = {}) => ({ cur: ++cur, type: "session." + type, data, ...top });

test("who parses; a bare id is a person", () => {
  assert.deepEqual(parseWho("assistant:kit"), { family: "assistant", id: "kit" });
  assert.deepEqual(parseWho("model:sonnet"), { family: "model", id: "sonnet" });
  assert.deepEqual(parseWho("alex"), { family: "person", id: "alex" });
});

test("an assistant says who it acts for; people and models say nothing", () => {
  assert.deepEqual(authorLabel({ author: "assistant:kit", acts_for: "person:chris", viewer: V }), { name: "kit", family: "assistant", sub: "for Chris" });
  assert.equal(authorLabel({ author: "assistant:juno", acts_for: V, viewer: V }).sub, "for you");
  assert.equal(authorLabel({ author: "assistant:kit", viewer: V }).sub, null);
  assert.equal(authorLabel({ author: "person:chris", viewer: V }).sub, null);
  assert.equal(authorLabel({ author: "model:opus", acts_for: "person:chris", viewer: V }).sub, null);
  assert.equal(authorLabel({ author: "assistant:kit", acts_for: "person:chris", viewer: V, names: { "person:chris": "chris lane" } }).sub, "for Chris lane");
});

test("the header shows up to three faces, then +n, never the viewer when others are here", () => {
  const p = (/** @type {string} */ id, family = "person") => ({ id: `${family}:${id}`, name: id, family });
  const all = [p("alex"), p("chris"), p("kit", "assistant"), p("juno", "assistant"), p("rev", "assistant"), p("dana")];
  const s = avatarStack(all, V);
  assert.deepEqual(s.shown.map((x) => x.name), ["chris", "kit", "juno"]);
  assert.equal(s.more, 2);
  assert.deepEqual(avatarStack([p("alex"), p("kit", "assistant")], V).shown.map((x) => x.name), ["kit"]);
  assert.deepEqual(avatarStack([p("alex")], V), { shown: [{ id: "person:alex", name: "alex", family: "person" }], more: 0 });
  assert.equal(avatarStack(all, V, 5).more, 0);
});

test("the New divider sits before the first other-author message after the marker", () => {
  const msgs = [
    { key: "u:m1", cur: 2, author: "person:chris" },
    { key: "a:k1", cur: 5, author: "assistant:kit" },
    { key: "u:m2", cur: 8, author: V },
    { key: "a:j1", cur: 9, author: "assistant:juno" },
  ];
  assert.deepEqual(unreadDivider(msgs, 2, V), { key: "a:k1", count: 2 });
  assert.deepEqual(unreadDivider(msgs, 5, V), { key: "a:j1", count: 1 });
  assert.deepEqual(unreadDivider(msgs, 9, V), { key: null, count: 0 });
  assert.deepEqual(unreadDivider(msgs, 0, V), { key: null, count: 0 }, "no marker, nothing is new");
  assert.deepEqual(unreadDivider([{ key: "u:m2", cur: 8, author: V }], 3, V), { key: null, count: 0 }, "your own messages are never new");
});

test("the presence line reads naturally and leaves the viewer out", () => {
  const m = (/** @type {any[]} */ ...e) => new Map(e);
  assert.equal(presenceLine(m(["person:chris", { state: "typing" }]), V), "chris is typing");
  assert.equal(presenceLine(m(["person:chris", { state: "typing" }], ["person:dana", { state: "typing" }]), V), "chris and dana are typing");
  assert.equal(presenceLine(m(["assistant:kit", { state: "doing", doing: "running the tests" }]), V), "kit is running the tests");
  assert.equal(presenceLine(m([V, { state: "typing" }]), V), "");
  assert.equal(presenceLine(m(["person:chris", { state: "typing" }], ["assistant:kit", { state: "doing", doing: "running the tests" }]), V), "chris is typing · kit is running the tests");
});

test("an approval is for the asker; anybody else sees it waiting", () => {
  assert.deepEqual(askAudience({ asker: V, viewer: V }), { mine: true, waitingFor: null });
  assert.deepEqual(askAudience({ asker: null, viewer: V }), { mine: true, waitingFor: null });
  assert.deepEqual(askAudience({ asker: "person:chris", viewer: V }), { mine: false, waitingFor: "Chris" });
});

test("fan-out keep: one answer, once, by message or author", () => {
  const fo = { group: "f1", message: "m5", members: [{ message: "f1a", author: "model:sonnet" }, { message: "f1b", author: "model:opus" }], kept: null };
  assert.deepEqual(fanoutKeep(fo, "f1b"), { ok: true, keep: "f1b" });
  assert.deepEqual(fanoutKeep(fo, "model:sonnet"), { ok: true, keep: "f1a" });
  assert.equal(fanoutKeep(fo, "nope").ok, false);
  assert.equal(fanoutKeep({ ...fo, kept: "f1a" }, "f1b").ok, false, "already kept");
  assert.equal(fanoutKeep(undefined, "f1a").ok, false);
});

test("a mention is found by frame or by the text", () => {
  assert.equal(textMentions("hi @alex, look", "alex"), true);
  assert.equal(textMentions("mail alex@x.com", "alex"), false);
  assert.equal(textMentions("@alexa", "alex"), false);
});

test("the sealed note is remembered per chat and survives a broken store", () => {
  const mem = new Map();
  const storage = { getItem: (/** @type {string} */ k) => mem.get(k) ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => void mem.set(k, v) };
  assert.equal(sealedNoteSeen(storage, "c1"), false);
  markSealedNoteSeen(storage, "c1");
  assert.equal(sealedNoteSeen(storage, "c1"), true);
  assert.equal(sealedNoteSeen(storage, "c2"), false);
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  assert.equal(sealedNoteSeen(broken, "c1"), false);
  assert.doesNotThrow(() => markSealedNoteSeen(broken, "c1"));
  assert.equal(sealedNoteSeen(undefined, "c1"), false);
  assert.match(sealedNoteText({ sealed: 2, assistants: 1 }), /2 sealed fields stay hidden/);
  assert.match(sealedNoteText({ sealed: 0, assistants: 2 }), /^Assistants here/);
});

test("the group folds a conversation: authors, presence, reactions, pins, threads, marker, fan-out, cuts", () => {
  cur = 0;
  const g = createGroup(V);
  g.apply(fr("participant-joined", { who: V, name: "alex" }));
  g.apply(fr("participant-joined", { who: "person:chris", name: "chris" }));
  g.apply(fr("participant-joined", { who: "assistant:kit", name: "kit" }));
  assert.deepEqual(g.participants().map((p) => p.name), ["alex", "chris", "kit"]);

  g.apply(fr("user-message", { message: "m1", text: "@alex check this", state: "sent" }, { author: "person:chris", message: "m1" }));
  g.apply(fr("mention", { who: V }, { message: "m1" }));
  assert.equal(g.mentioned("m1"), true);
  assert.equal(g.label("u:m1").name, "chris");
  assert.equal(g.isMine("u:m1"), false);

  g.apply(fr("read-marker", { upto: 1 }, { author: V }));
  const r = g.apply(fr("text-delta", { message: "k1", index: 0, text: "On it" }, { author: "assistant:kit", acts_for: "person:chris", message: "k1" }));
  assert.ok(r.touched.includes("a:k1"));
  assert.deepEqual(g.label("a:k1"), { name: "kit", family: "assistant", sub: "for Chris" });
  assert.deepEqual(g.divider(), { key: "u:m1", count: 2 }, "m1 (cur 4) and k1 are after the marker");
  g.apply(fr("read-marker", { upto: 99 }, { author: "person:chris" }));
  assert.equal(g.readUpto, 1, "another person's marker is not mine");

  g.apply(fr("presence", { who: "assistant:kit", state: "doing", doing: "running the tests" }));
  assert.equal(g.presenceLine(), "kit is running the tests");
  g.apply(fr("presence", { who: "assistant:kit", state: "idle" }));
  assert.equal(g.presenceLine(), "");

  g.apply(fr("reaction", { emoji: "+1" }, { author: V, message: "k1" }));
  g.apply(fr("reaction", { emoji: "+1" }, { author: "person:chris", message: "k1" }));
  assert.deepEqual(g.reactions("k1"), [{ emoji: "+1", count: 2, mine: true }]);
  g.apply(fr("reaction", { emoji: "+1", remove: true }, { author: V, message: "k1" }));
  assert.deepEqual(g.reactions("k1"), [{ emoji: "+1", count: 1, mine: false }]);

  g.apply(fr("pin", {}, { message: "k1" }));
  assert.equal(g.pinned("k1"), true);
  g.apply(fr("thread-reply", { parent: "k1" }, { message: "m1" }));
  assert.equal(g.replyCount("k1"), 1);
  assert.equal(g.parent("m1"), "k1");

  g.apply(fr("text-cut", { note: "Cut off at the limit" }, { message: "k1" }));
  assert.equal(g.cut("k1"), "Cut off at the limit");

  g.apply(fr("text-delta", { message: "f1a", index: 0, text: "x" }, { author: "model:sonnet", message: "f1a" }));
  g.apply(fr("fanout", { group: "f1", members: [{ message: "f1a", author: "model:sonnet" }, "f1b"], message: "m5" }));
  assert.equal(g.fanoutAt("a:f1a")?.first, true);
  assert.equal(g.fanoutAt("a:f1b")?.first, false);
  assert.equal(g.fanoutAt("a:k1"), null);
  const t = g.apply(fr("fanout-keep", { group: "f1", keep: "f1b" }));
  assert.equal(g.fanout("f1")?.kept, "f1b");
  assert.ok(t.touched.includes("a:f1a"));
  g.apply(fr("fanout-keep", { group: "f1", keep: "f1a" }));
  assert.equal(g.fanout("f1")?.kept, "f1b", "kept once");

  const before = g.rev;
  g.apply({ cur: 3, type: "session.pin", data: {}, message: "m1" });
  assert.equal(g.rev, before, "a replayed cursor changes nothing");
  g.apply({ cur: 0, type: "session.reset", data: { head: 500 } });
  assert.equal(g.participants().length, 0);
  assert.equal(g.last, 500);
});

test("a fan-out set draws at the first member that has a row", () => {
  cur = 0;
  const g = createGroup(V);
  g.apply(fr("fanout", { group: "f9", members: ["x1", "x2"], message: "m" }));
  g.apply(fr("text-delta", { message: "x2", index: 0, text: "b" }, { author: "model:opus", message: "x2" }));
  assert.equal(g.fanoutAt("a:x2")?.first, true);
  g.apply(fr("text-delta", { message: "x1", index: 0, text: "a" }, { author: "model:sonnet", message: "x1" }));
  assert.equal(g.fanoutAt("a:x1")?.first, true, "x1 is the first member that now has a row");
  assert.equal(g.fanoutAt("a:x2")?.first, false);
});
