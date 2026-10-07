// @ts-check
// The chat tools the first pass left, over a fake box: every tool name and input is the Deck's.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { seen.push({ tool, input }); return o[tool] ?? { data: {} }; };
  return { call, seen };
}

test("a watcher card keeps its facts as given and checks every field", { skip: !strip }, async () => {
  const m = await import("./more-model.ts");
  assert.equal(m.watcherCardOf({}), null);
  const c = m.watcherCardOf({ name: "intake", hash: "h1", state: "draft", owner: { kind: "teammate", teammate: "kit" }, described: "by its author", lines: { when: "Mon", check: "new mail", do: "tell me" },
    facts: { reads: ["inbox"], readsText: "Reads mail", credentials: [{ host: "gmail", item: "work" }, { nope: 1 }], acts: "Sends nothing", cost: "free", schedule: "hourly" } });
  assert.equal(c?.owner, "Owned by kit");
  assert.equal(c?.described, "by its author");
  assert.deepEqual(c?.facts.credentials, [{ host: "gmail", item: "work" }]);
  assert.equal(m.watcherCardOf({ name: "x", described: "something" })?.described, "by Vyre");
  assert.equal(m.ownerWords({ project: "intake" }), "Owned by the intake project");
});

test("turn on carries the card's hash; pause does not; a moved hash is refused and offers the new card", { skip: !strip }, async () => {
  const m = await import("./more-model.ts");
  assert.deepEqual(m.watcherCall("on", { name: "w", hash: "h" }), { tool: "watchers.create", input: { name: "w", hash: "h" } });
  assert.deepEqual(m.watcherCall("resume", { name: "w", hash: "h" }), { tool: "watchers.resume", input: { name: "w", hash: "h" } });
  assert.deepEqual(m.watcherCall("pause", { name: "w", hash: "h" }), { tool: "watchers.pause", input: { name: "w" } });
  const { moreToolsSource } = await import("./more-source.ts");
  const b = box({ "watchers.create": { error: { code: "refused", message: "The code changed after its card was shown." } } });
  const r = await moreToolsSource(b.call).watcher("on", { name: "w", hash: "h" });
  assert.deepEqual(r.ok, false);
  assert.equal(/** @type {any} */ (r).changed, true);
  assert.deepEqual(b.seen, [{ tool: "watchers.create", input: { name: "w", hash: "h" } }]);
});

test("a spend cap raise: dollars checked, provider checked as a name, off sends off", { skip: !strip }, async () => {
  const m = await import("./more-model.ts");
  assert.equal(m.capDollars("$12.345"), 12.35);
  assert.equal(m.capDollars("0"), null);
  assert.equal(m.capDollars("abc"), null);
  assert.equal(m.providerOf("claude"), "claude");
  assert.equal(m.providerOf("Claude; drop"), "");
  assert.equal(m.suggestedCap({ cap: 5 }), 10);
  assert.equal(m.suggestedCap({ action: { input: { to: 7 } } }), 7);
  assert.equal(m.suggestedCap({}), 10);
  assert.equal(m.capLine("claude", null), "Claude has no daily cap now.");
  assert.equal(m.capLine("all", 8), "The daily cap over every provider is $8. Resume to go on.");
  const { moreToolsSource } = await import("./more-source.ts");
  const b = box({ "spend.raise": { data: { cap: 12.5 } } });
  const s = moreToolsSource(b.call);
  assert.deepEqual(await s.raiseCap("claude", "12.5"), { ok: true, cap: 12.5 });
  assert.deepEqual(await s.raiseCap("claude", null), { ok: true, cap: 12.5 });
  assert.equal((await s.raiseCap("claude", "-3")).ok, false);
  assert.deepEqual(b.seen.map((x) => x.input), [{ provider: "claude", to: 12.5 }, { provider: "claude", off: true }]);
});

test("the welcome keeps only cards with an id and a title, and only https links", { skip: !strip }, async () => {
  const m = await import("./more-model.ts");
  const w = m.welcomeOf({ text: "Hi", cards: [{ id: "claude", title: "Connect Claude", body: "b" }, { id: "t", title: "Tailscale", href: "https://login.tailscale.com/x" }, { id: "bad", title: "Bad", href: "javascript:alert(1)" }, { title: "no id" }] });
  assert.equal(w.text, "Hi");
  assert.deepEqual(w.cards.map((c) => [c.id, c.href]), [["claude", ""], ["t", "https://login.tailscale.com/x"], ["bad", ""]]);
  assert.deepEqual(m.welcomeOf(null), { text: "", cards: [] });
});

test("artifact activity reads newest first; the render path is the box's own and encodes the id", { skip: !strip }, async () => {
  const m = await import("./more-model.ts");
  const rows = m.activityOf({ events: [{ kind: "opened", at: 1, by: "you" }, { kind: "navigated-away", at: 5 }, { nope: 1 }] });
  assert.deepEqual(rows.map((r) => r.kind), ["navigated-away", "opened"]);
  assert.equal(rows[0].line, "It tried to leave its page");
  assert.equal(m.renderPath("a/b c", 3), "/v1/artifacts/content?id=a%2Fb%20c&v=3");
  assert.equal(m.mediaPath("x", true), "/v1/artifacts/content?id=x&download=1");
  const { moreToolsSource } = await import("./more-source.ts");
  const b = box({ "artifacts.activity.log": { data: [{ kind: "shared", at: 2 }] } });
  const s = moreToolsSource(b.call);
  assert.equal((await s.activity("a1")).length, 1);
  await s.frameLeft("a1");
  assert.deepEqual(b.seen.map((x) => x.input), [{ id: "a1" }, { id: "a1", kind: "navigated-away" }]);
});

test("files, recall and memory answers: bad rows dropped, the Mac note, the history problem in words", { skip: !strip }, async () => {
  const m = await import("./more-model.ts");
  const f = m.fileHitsOf({ results: [{ path: "/Users/me/work/a.md", name: "a.md", source: "box", size: 10 }, { name: "no path" }], sources: [{ source: "mac", ok: false, error: "asleep" }] });
  assert.equal(f.results.length, 1);
  assert.deepEqual(f.notes, ["The Mac did not answer: asleep", "Files on your Mac are not searched from here."]);
  assert.deepEqual(m.fileHitsOf({ results: [] }).notes, ["Files on your Mac are not searched from here."]);
  assert.equal(m.recentFilesOf({ files: [{ path: "/a" }] }).length, 1);
  assert.deepEqual(m.recallOf([{ session: "s1", name: "N", snippet: "a «b» c" }, { name: "none" }]).map((x) => x.snippet), ["a b c"]);
  assert.deepEqual(m.factsOf([{ text: "t", ref: { name: "Mail" } }, { text: "" }]), [{ text: "t", source: "Mail" }]);
  assert.equal(m.indexProblem(null), null);
  assert.equal(m.indexProblem({ code: "missing" }), "The history module is not running, so history cannot be read here.");
});

test("find's calls, edit, close and suggestions send the Deck's inputs", { skip: !strip }, async () => {
  const { moreToolsSource } = await import("./more-source.ts");
  const b = box({ "recall.search": { data: [{ session: "s1" }] }, "files.search": { data: { results: [] } }, "memory.relevant": { data: [{ text: "x" }] } });
  const s = moreToolsSource(b.call);
  await s.searchChats("intake", 20); await s.searchFiles("intake"); await s.searchMemory("intake");
  await s.recentFiles(); await s.related("/w", "hi"); await s.thread("s1", 0, 400, "mac"); await s.preview("/a", "box");
  await s.editQueued("t1", 3, "new", [{ id: "x" }]); await s.closeTerm("tm1"); await s.suggest("hel", 99); await s.picked({ kind: "file", source: "box", id: "i" });
  await s.watch("t1", "either"); await s.indexHistory(); await s.gate("g1");
  assert.deepEqual(b.seen.map((x) => [x.tool, x.input]), [
    ["recall.search", { q: "intake", limit: 20 }], ["files.search", { q: "intake", limit: 20 }], ["memory.relevant", { text: "intake", limit: 5 }],
    ["files.recent", { limit: 8 }], ["recall.related", { project_cwds: ["/w"], text: "hi", limit: 3 }], ["recall.thread", { session: "s1", from: 0, limit: 400, source: "mac" }],
    ["files.preview", { path: "/a", source: "box" }], ["threads.edit", { thread: "t1", queued: 3, text: "new", mentions: [{ id: "x" }], pasted: [] }],
    ["term.close", { term: "tm1" }], ["suggest.query", { text: "hel", cursor: 3, surface: "chat" }], ["suggest.picked", { kind: "file", source: "box", id: "i" }],
    ["threads.watch", { thread: "t1", until: "either", notify: "deck" }], ["recall.index", {}], ["gate.get", { id: "g1" }],
  ]);
});

import { activityOf as activityOfVia } from "./more-model.ts";
test("an artifact activity row the person's assistant made is marked", () => {
  const rows = activityOfVia({ events: [{ kind: "opened", at: 2, actor: "per_a1", acted_via: "assistant" }, { kind: "shared", at: 1, actor: "per_a1" }] });
  assert.equal(rows[0].via, "assistant");
  assert.equal(rows[1].via, undefined);
});
