// @ts-check
// The PR review card (pr-review.js) in the fake DOM with a fake vyred behind fetch: what it shows,
// which button is live for which checks, the exact pr.merge / pr.review / threads.answer calls, the
// error and offline lines, collaborator comments (collapsed, text only), and no agent path to
// approve. Sample world only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "../../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: {} });

/** A fake vyred: tools by name, every call recorded. An answer may be a function of the input; { $error } is a refusal. */
function vyred(answers = {}) {
  const calls = [];
  globalThis.fetch = /** @type {any} */ (async (url, o) => {
    const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
    const input = JSON.parse(o.body);
    calls.push({ tool, input });
    const a0 = tool in answers ? answers[tool] : { ok: true };
    const a = typeof a0 === "function" ? a0(input) : a0;
    if (a && a.$error) return { status: 409, statusText: "", json: async () => ({ error: a.$error }) };
    return { status: 200, statusText: "", json: async () => ({ data: a }) };
  });
  return { calls, of: t => calls.filter(c => c.tool === t) };
}
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 5)); };
const Ev = (type, o = {}) => Object.assign(new /** @type {any} */ (globalThis).Event(type), o);
/** Type into a note line. @param {any} field @param {string} v */
const type = (field, v) => { field.value = v; field.dispatchEvent(Ev("input")); };

const { prReview, checkState } = await import("./pr-review.js");

const hunk = (lines = [" keep", "-old", "+new"]) => [{ oldStart: 1, newStart: 1, lines }];
const PR = (o = {}) => ({
  kind: "pr_review", pr: 412, project: "northwind", repo: "northwind/site", title: "Add the pumpkin loaf to the price list",
  branch: { from: "feature/pumpkin-loaf", to: "main" },
  summary: "Adds the pumpkin loaf to prices.json and the price list page.",
  checks: [{ name: "build", state: "done" }, { name: "tests", state: "done" }, { name: "lint", state: "done" }],
  files: [
    { path: "prices.json", additions: 4, deletions: 0, hunks: hunk() },
    { path: "src/menu/PriceList.js", additions: 12, deletions: 4, hunks: hunk() },
  ],
  comments: [], state: "open", ...o,
});
const ASK = (o = {}) => ({ id: "ask-pr-1", ...PR(o), agent: "kit" });
const card = (d, ctx = {}) => prReview(d, { thread: "t-pr", phone: false, ...ctx });

test("display: header, branch pair, summary, check chips with status words, files, footer buttons", () => {
  const c = card(PR());
  assert.equal(c.getAttribute("aria-label"), "Pull request #412 Add the pumpkin loaf to the price list");
  assert.match(text($(c, ".cv-card-head")), /#412 Add the pumpkin loaf to the price list\s*feature\/pumpkin-loaf \u2192 main/);
  assert.match(text($(c, ".cv-prr-summary")), /pumpkin loaf to prices\.json/);
  assert.deepEqual($$(c, ".cv-prr-checks .cv-chip").map(x => x.getAttribute("data-check")), ["build", "tests", "lint"]);
  assert.match(text($(c, "[data-check=build]")), /build, passed/);
  assert.equal($$(c, ".cv-df").length, 2, "the multi-file diff is embedded");
  assert.equal($$(c, ".cv-df-row")[0].getAttribute("aria-expanded"), "true");
  assert.deepEqual($$(c, ".cv-prr-actions .btn").map(b => b.getAttribute("data-act")), ["merge", "changes", "comment"]);
  assert.match(text($(c, "[data-act=merge]")), /^Approve and merge/);
  assert.equal($(c, "[data-act=merge]").getAttribute("aria-keyshortcuts"), "Meta+Enter Control+Enter");
  assert.equal($(c, "[data-act=merge]").disabled, false);
  assert.equal(c.isOpen(), false, "a display card blocks nothing");
  assert.equal(JSON.parse(c.getAttribute("data-compact")).checks.length, 3, "Lumen reads data-compact");
  assert.equal(JSON.parse(c.getAttribute("data-compact")).title, "#412 Add the pumpkin loaf to the price list");
});

test("checks: any running check disables Approve and reads Waiting on checks; a failed one keeps it live and reads anyway", () => {
  assert.equal(checkState({ state: "in_progress" }), "running");
  assert.equal(checkState({ conclusion: "failure" }), "failed");
  assert.equal(checkState({ state: "success" }), "done");
  const running = card(PR({ checks: [{ name: "build", state: "done" }, { name: "lint", state: "running" }] }));
  const m = $(running, "[data-act=merge]");
  assert.equal(m.disabled, true);
  assert.equal(text(m), "Waiting on checks");
  assert.equal(m.getAttribute("title"), "Waiting on checks");
  const failed = card(PR({ checks: [{ name: "build", state: "done" }, { name: "tests", state: "failed", log: "1 failing: menu renders\nExpected 6 got 5" }] }));
  assert.equal($(failed, "[data-act=merge]").disabled, false);
  assert.match(text($(failed, "[data-act=merge]")), /^Approve and merge anyway/);
  assert.equal($(failed, "[data-check=tests]").tagName, "BUTTON", "a failed chip with a log is tappable");
  assert.equal($(failed, "[data-check=build]").tagName, "SPAN");
  assert.equal($(failed, ".cv-prr-log"), null, "the log is collapsed");
  $(failed, "[data-check=tests]").click();
  assert.match(text($(failed, ".cv-prr-log")), /1 failing: menu renders/);
  $(failed, "[data-check=tests]").click();
  assert.equal($(failed, ".cv-prr-log"), null);
  const both = card(PR({ checks: [{ name: "a", state: "failed" }, { name: "b", state: "pending" }] }));
  assert.equal(text($(both, "[data-act=merge]")), "Waiting on checks", "running wins over failed");
});

test("Approve and merge calls pr.merge once, says Merging, then the footer collapses to Merged into main by you", async () => {
  const f = vyred();
  const c = card(PR());
  $(c, "[data-act=merge]").click();
  assert.match(text($(c, "[data-act=merge]")), /Merging/);
  assert.equal($(c, "[data-act=changes]").disabled, true);
  $(c, "[data-act=merge]").click();
  await settle();
  assert.equal(f.of("github.project.pr.merge").length, 1, "a second click while busy does nothing");
  assert.deepEqual(f.of("github.project.pr.merge")[0].input, { project: "northwind", pr: 412 });
  assert.equal(f.of("threads.answer").length, 0, "a display card has no ask to answer");
  assert.match(text($(c, ".cv-prr-foot")), /Merged into main by you \u00b7 just now/);
  assert.equal($(c, ".cv-prr-actions"), null);
  assert.equal($(c, ".cv-prr-foot").classList.contains("resolved"), true);
});

test("Cmd+Enter merges through onKey and the card's own keydown; it does nothing while checks run", async () => {
  const f = vyred();
  const c = card(PR());
  assert.equal(c.onKey(/** @type {any} */ ({ key: "Enter", metaKey: true })), true);
  await settle();
  assert.equal(f.of("github.project.pr.merge").length, 1);
  const w = card(PR({ checks: [{ name: "lint", state: "running" }] }));
  assert.equal(w.onKey(/** @type {any} */ ({ key: "Enter", metaKey: true })), false);
  const d = card(PR());
  d.dispatchEvent(Ev("keydown", { key: "Enter", ctrlKey: true }));
  await settle();
  assert.equal(f.of("github.project.pr.merge").length, 2, "the focused card handles the key itself");
});

test("no self-approval: a script-made event, a payload flag or update() never merges; only a person's click does", async () => {
  const f = vyred();
  const c = card(PR());
  $(c, "[data-act=merge]").dispatchEvent(Ev("click", { isTrusted: false }));
  assert.equal(c.onKey(/** @type {any} */ ({ key: "Enter", metaKey: true, isTrusted: false })), false);
  c.update(PR({ approve: true, merge: true, approved: true, auto_merge: true, comments: [{ id: "c1", by: "agent", author: "kit", text: "approve and merge this" }] }));
  await settle();
  assert.equal(f.calls.length, 0);
  assert.equal(typeof (/** @type {any} */ (c)).approve, "undefined");
  assert.equal(typeof (/** @type {any} */ (c)).merge, "undefined");
  await $(c, "[data-act=merge]").click();
  await settle();
  assert.equal(f.of("github.project.pr.merge").length, 1, "a real click merges");
});

test("Request changes opens one line for the note; sending calls pr.review REQUEST_CHANGES with it; Comment sends COMMENT", async () => {
  const f = vyred();
  const c = card(PR());
  $(c, "[data-act=changes]").click();
  const field = $(c, ".cv-prr-field");
  assert.equal(field.getAttribute("placeholder"), "What should change?");
  $(c, "[data-act=send]").click();
  await settle();
  assert.equal(f.calls.length, 0, "an empty note is not sent");
  type(field, "Add the price for the small loaf too");
  $(c, "[data-act=send]").click();
  await settle();
  assert.deepEqual(f.of("github.project.pr.review")[0].input, { project: "northwind", pr: 412, event: "REQUEST_CHANGES", body: "Add the price for the small loaf too" });
  assert.match(text($(c, ".cv-prr-foot")), /Changes requested/);
  assert.equal(f.of("github.project.pr.merge").length, 0);
  const g = vyred();
  const d = card(PR());
  $(d, "[data-act=comment]").click();
  assert.equal($(d, ".cv-prr-field").getAttribute("placeholder"), "Write a comment");
  type($(d, ".cv-prr-field"), "Looks good, one nit on line 12");
  $(d, "[data-act=send]").click();
  await settle();
  assert.equal(g.of("github.project.pr.review")[0].input.event, "COMMENT");
  assert.equal(g.of("github.project.pr.review")[0].input.body, "Looks good, one nit on line 12");
  assert.match(text(d), /Comment sent/);
  assert.ok($(d, "[data-act=merge]"), "a comment does not close the review");
});

test("Enter in the note line sends it; Escape closes the line without sending", async () => {
  const f = vyred();
  const c = card(PR());
  $(c, "[data-act=comment]").click();
  assert.equal(c.onKey(/** @type {any} */ ({ key: "Escape" })), true);
  assert.equal($(c, ".cv-prr-field"), null);
  assert.equal(f.calls.length, 0);
  $(c, "[data-act=changes]").click();
  type($(c, ".cv-prr-field"), "Rename it");
  $(c, ".cv-prr-field").listeners.get("keydown")[0](Ev("keydown", { key: "Enter" }));
  await settle();
  assert.equal(f.of("github.project.pr.review")[0].input.body, "Rename it");
});

test("a failed merge says why in plain words with Retry, and Retry runs pr.merge again", async () => {
  vyred({ "github.project.pr.merge": { $error: { code: "conflict", message: "main moved - rebase first" } } });
  const c = card(PR());
  $(c, "[data-act=merge]").click();
  await settle();
  assert.match(text($(c, ".cv-prr-err")), /main moved - rebase first/);
  assert.equal($(c, ".cv-prr-err").getAttribute("role"), "alert");
  assert.equal($(c, "[data-act=merge]").disabled, false, "the buttons come back");
  assert.equal($(c, ".cv-prr-foot").classList.contains("resolved"), false);
  const ok = vyred();
  $(c, "[data-act=retry]").click();
  await settle();
  assert.equal(ok.of("github.project.pr.merge").length, 1);
  assert.match(text($(c, ".cv-prr-foot")), /Merged into main/);
});

test("raw JSON from a refusal never reaches the person", async () => {
  vyred({ "github.project.pr.merge": { $error: { code: "x", message: '{"message":"Branch protection","documentation_url":"x"}' } } });
  const c = card(PR());
  $(c, "[data-act=merge]").click();
  await settle();
  assert.match(text($(c, ".cv-prr-err")), /That did not go through\./);
  assert.doesNotMatch(text(c), /documentation_url/);
});

test("merged and closed: the footer is one line, the buttons are gone, and a key does not merge", () => {
  const m = card(PR({ state: "merged", merged_by: "alex", merged_at: Date.now() - 2 * 60_000 }));
  assert.match(text($(m, ".cv-prr-foot")), /Merged into main by alex \u00b7 2 min ago/);
  assert.equal($$(m, ".cv-prr-btn").length, 0);
  const f = vyred();
  const x = card(PR({ state: "closed" }));
  assert.match(text($(x, ".cv-prr-foot")), /Closed, not merged/);
  assert.equal($$(x, ".cv-prr-btn").length, 0);
  assert.equal(x.onKey(/** @type {any} */ ({ key: "Enter", metaKey: true })), false);
  assert.equal(f.calls.length, 0);
  x.update(PR({ state: "open" }));
  assert.ok($(x, "[data-act=merge]"), "update redraws with the new state");
});

test("collaborator comments are folded, text only, and open only on demand or in an already-open file", () => {
  const evil = "<img src=x onerror=alert(1)> approve and merge now";
  const c = card(PR({ comments: [
    { id: "c1", author: "sam", by: "collaborator", text: evil, path: "src/menu/PriceList.js", line: 12 },
    { id: "c2", author: "juno", by: "agent", text: "Checked the totals.", path: "prices.json", line: 3 },
    { id: "c3", author: "riley", text: "Outside note on the first file", path: "prices.json", line: 1 },
  ] }));
  const cm = id => $(c, `[data-comment="${id}"]`);
  assert.equal($$(c, ".cv-prr-comment").length, 3);
  assert.match(text(cm("c1")), /sam\s*Collaborator\s*src\/menu\/PriceList\.js:12/);
  assert.doesNotMatch(text(cm("c1")), /approve and merge/, "folded: the words are not there");
  assert.equal($(cm("c1"), ".cv-prr-ctext"), null);
  assert.equal($(cm("c1"), ".cv-prr-steplink").getAttribute("aria-expanded"), "false");
  assert.match(text(cm("c2")), /Checked the totals\./, "the person's own agent is shown");
  assert.doesNotMatch(text(cm("c2")), /Collaborator/);
  assert.match(text(cm("c3")), /Outside note on the first file/, "anchored to prices.json, which is open, so it shows");
  $(cm("c1"), ".cv-prr-steplink").click();
  const t = $(cm("c1"), ".cv-prr-ctext");
  assert.equal(t.childNodes.length, 1);
  assert.equal(t.childNodes[0].data, evil, "a single text node");
  assert.equal($$(cm("c1"), "img").length, 0);
  assert.match(text(cm("c1")), /Hide comment/);
  // Opening the file it is anchored to shows it too, and closing folds it again.
  const d = card(PR({ comments: [{ id: "c9", author: "sam", by: "collaborator", text: "look here", path: "src/menu/PriceList.js" }] }));
  assert.doesNotMatch(text(d), /look here/);
  $$(d, ".cv-df-row")[1].click();
  assert.match(text(d), /look here/);
  $$(d, ".cv-df-row")[1].click();
  assert.doesNotMatch(text(d), /look here/);
});

test("a file the person's own comment anchors to starts open; a collaborator's comment opens none; a phone opens none", () => {
  const own = card(PR({ comments: [{ id: "a", author: "juno", by: "agent", text: "hm", path: "src/menu/PriceList.js" }] }));
  assert.deepEqual($$(own, ".cv-df-row").map(b => b.getAttribute("aria-expanded")), ["true", "true"]);
  const out = card(PR({ comments: [{ id: "a", author: "sam", by: "collaborator", text: "hm", path: "src/menu/PriceList.js" }] }));
  assert.deepEqual($$(out, ".cv-df-row").map(b => b.getAttribute("aria-expanded")), ["true", "false"]);
  const ph = card(PR({ comments: [{ id: "a", author: "juno", by: "agent", text: "hm", path: "src/menu/PriceList.js" }] }), { phone: true });
  assert.deepEqual($$(ph, ".cv-df-row").map(b => b.getAttribute("aria-expanded")), ["false", "false"]);
});

test("Reply opens the comment line prefilled with the anchor and sends in_reply_to", async () => {
  const f = vyred();
  const c = card(PR({ comments: [{ id: 77, author: "juno", by: "agent", text: "Should this also cover the small loaf?", path: "prices.json", line: 3 }] }));
  $(c, "[data-act=reply]").click();
  assert.equal($(c, ".cv-prr-field").value, "Re prices.json:3: ");
  type($(c, ".cv-prr-field"), "Re prices.json:3: yes, adding it");
  $(c, "[data-act=send]").click();
  await settle();
  const i = f.of("github.project.pr.review")[0].input;
  assert.equal(i.event, "COMMENT");
  assert.equal(i.in_reply_to, 77);
});

test("ask form: says who asks, answers the ask on merge (allow) and on request changes (deny with the note)", async () => {
  const f = vyred();
  const c = card(ASK());
  assert.match(text(c), /kit asks you to review this/);
  assert.equal(c.isOpen(), true);
  $(c, "[data-act=merge]").click();
  await settle();
  assert.deepEqual(f.calls.map(x => x.tool), ["github.project.pr.merge", "threads.answer"]);
  assert.deepEqual(f.of("threads.answer")[0].input, { ask: "ask-pr-1", decision: "allow", surface: "deck" });
  assert.equal(c.isOpen(), false);
  assert.match(text(c), /Merged into main by you/);
  assert.doesNotMatch(text(c), /asks you to review/);
  const g = vyred();
  const d = card(ASK());
  $(d, "[data-act=changes]").click();
  type($(d, ".cv-prr-field"), "Rename the loaf");
  $(d, "[data-act=send]").click();
  await settle();
  assert.deepEqual(g.calls.map(x => x.tool), ["github.project.pr.review", "threads.answer"]);
  assert.deepEqual(g.of("threads.answer")[0].input, { ask: "ask-pr-1", decision: "deny", surface: "deck", message: "Rename the loaf" });
  assert.equal(d.isOpen(), false);
});

test("ask form: fields in detail read the same; if the answer fails Retry only answers, the merge is not repeated", async () => {
  const f = vyred({ "threads.answer": { $error: { code: "timeout", message: "Your server did not answer" } } });
  const c = card({ id: "ask-pr-2", kind: "pr_review", agent: "kit", detail: PR() });
  assert.match(text($(c, ".cv-card-head")), /#412/);
  $(c, "[data-act=merge]").click();
  await settle();
  assert.match(text($(c, ".cv-prr-err")), /Your server did not answer/);
  assert.equal(c.isOpen(), true);
  const g = vyred();
  $(c, "[data-act=retry]").click();
  await settle();
  assert.equal(g.of("github.project.pr.merge").length, 0, "the merge already went through");
  assert.equal(g.of("threads.answer").length, 1);
  assert.equal(c.isOpen(), false);
  assert.equal(f.of("github.project.pr.merge").length, 1);
});

test("ask form: answered elsewhere collapses the footer and says where", () => {
  const c = card(ASK());
  c.answered("allow", null, { where: "the phone", at: Date.now() });
  assert.match(text($(c, ".cv-prr-foot")), /Approved on another screen/);
  assert.match(text($(c, ".cv-prr-foot")), /Answered from the phone \u00b7 \d\d:\d\d/);
  assert.equal(c.isOpen(), false);
  assert.equal($$(c, ".cv-prr-btn").length, 0);
});

test("offline: the merge waits in the outbox and the card says Approving \u00b7 sends when back online", async () => {
  // The outbox retries a parked write on a long timer; keep that timer from holding the test process open.
  const realSet = globalThis.setTimeout;
  globalThis.setTimeout = /** @type {any} */ ((fn, ms, ...a) => { const t = realSet(fn, ms, ...a); if (ms >= 1000) t.unref?.(); return t; });
  globalThis.fetch = /** @type {any} */ (async () => { throw new TypeError("network down"); });
  const c = card(PR());
  $(c, "[data-act=merge]").click();
  await settle();
  globalThis.setTimeout = realSet;
  assert.match(text($(c, ".cv-prr-queued")), /Approving \u00b7 sends when back online/);
  assert.equal($(c, "[data-act=merge]").getAttribute("aria-busy"), "true");
});
