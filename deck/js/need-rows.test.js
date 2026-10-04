// @ts-check
// The phone's Needs you rows: titles, lines, labels and swipe releases (docs/design/phone.md 4, 5, 12).

import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { plainSummary, requestFacts, askTitle, draftTitle, titleOf, secondLine, thirdLine, ago, agoLong, ariaLabel, presenceWord, sessionHref,
  release, questionAnswers, changesLine, pushTarget, swipeActions, swipeCommit, sheetPrimary, toastFor, heldFor, sheetWho, factRows,
  deferred, snoozes, LATER_MS, SWIPE_HINT } from "./need-rows.js";

const NOW = 1_800_000_000_000;

test("need-rows: an ask is titled by the action it asks for", () => {
  assert.equal(askTitle("Bash", { command: "git push origin q3-report" }), "Push q3-report");
  assert.equal(askTitle("Bash", { command: "git push" }), "Push");
  assert.equal(askTitle("Bash", { command: "npm run build" }), "Run build");
  assert.equal(askTitle("Bash", { command: "npm test" }), "Run the tests");
  assert.equal(askTitle("Bash", { command: "rm -rf reports/old" }), "Delete old");
  assert.equal(askTitle("Bash", { command: "curl -s https://api.northwind.example/v1" }), "Fetch api.northwind.example");
  assert.equal(askTitle("Bash", { command: "/usr/bin/make deploy" }), "Run make");
  assert.equal(askTitle("Edit", { file: "/home/alex/harlow/reports/q3.tsx" }), "Edit q3.tsx");
  assert.equal(askTitle("WebFetch", { url: "https://harlowlegal.example/fees" }), "Fetch harlowlegal.example");
  assert.equal(askTitle("mcp__gmail__send_email", {}), "Use send email");
  assert.equal(askTitle("", {}, ""), "Run a command");
});

test("need-rows: a draft is a verb and a person", () => {
  assert.equal(draftTitle({ kind: "send", via: "gmail", to: ["dana@northwind.example"], toName: "Dana Wine" }), "Send email to Dana");
  assert.equal(draftTitle({ kind: "send", via: "slack", to: ["#ops"] }), "Send message to #ops");
  assert.equal(draftTitle({ kind: "spend", via: "stripe", to: [] }), "Spend through stripe");
  assert.equal(draftTitle(null), "Send a message");
  assert.equal(draftTitle({ kind: "send", via: "mail", to: ["dana@harlowlegal.com"] }), "Send email to Dana");
});

test("need-rows: three lines by kind", () => {
  const ask = { kind: "ask", at: NOW, agent: "kit", projectName: "Harlow Legal", tool: "Bash", detail: { command: "git push origin q3-report" } };
  assert.equal(titleOf(ask), "Push q3-report");
  assert.deepEqual(secondLine(ask), { text: "git push origin q3-report", mono: true });
  assert.equal(thirdLine(ask), "kit · Harlow Legal");
  const draft = { kind: "draft", at: NOW, agent: "kit", projectName: "Northwind Bakery", gate: { kind: "send", via: "gmail", to: ["dana@x.example"], toName: "Dana", draft: { subject: "Q3 report, the short version" } } };
  assert.deepEqual(secondLine(draft), { text: "Q3 report, the short version", mono: false });
  const q = { kind: "question", at: NOW, agent: "juno", questions: [{ question: "Which firm first?" }] };
  assert.equal(titleOf(q), "juno has a question");
  assert.equal(secondLine(q).text, "Which firm first?");
  assert.equal(thirdLine({ kind: "ask", at: NOW }), "a session");
  // No agent: the session's own name, then the project.
  assert.equal(thirdLine({ kind: "question", at: NOW, threadName: "Northwind menu page", projectName: "Northwind Bakery" }), "Northwind menu page · Northwind Bakery");
  assert.equal(thirdLine({ kind: "ask", at: NOW, agent: "kit", threadName: "Q3 report" }), "kit · Q3 report");
});

test("need-rows: time since held, short and spoken", () => {
  assert.equal(ago(NOW - 20_000, NOW), "now");
  assert.equal(ago(NOW - 12 * 60_000, NOW), "12m");
  assert.equal(ago(NOW - 3 * 3_600_000, NOW), "3h");
  assert.equal(ago(NOW - 3 * 86_400_000, NOW), "3d");
  assert.equal(agoLong(NOW - 4 * 60_000, NOW), "4 minutes ago");
  assert.equal(agoLong(NOW - 60_000, NOW), "1 minute ago");
});

test("need-rows: the row reads as section 12 says", () => {
  const ask = { kind: "ask", at: NOW - 4 * 60_000, agent: "kit", projectName: "Harlow Legal", tool: "Bash", detail: { command: "git push origin q3-report" } };
  assert.equal(ariaLabel(ask, NOW), "kit, Harlow Legal, wants to push q3-report, git push origin q3-report, 4 minutes ago. Actions: Approve, Deny, Open.");
  assert.deepEqual(swipeActions({ kind: "draft", at: 0, gate: { kind: "send" } }), ["Send", "Discard"]);
  assert.deepEqual(swipeActions({ kind: "question", at: 0 }), ["Answer", "Later"]);
});

test("need-rows: the presence word follows the device", () => {
  assert.equal(presenceWord("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), "Face ID");
  assert.equal(presenceWord("Mozilla/5.0 (Linux; Android 15; Pixel 9)"), "fingerprint");
  assert.equal(presenceWord("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", 0), "Touch ID");
  assert.equal(presenceWord("Mozilla/5.0 (X11; Linux x86_64)"), "passkey");
});

test("need-rows: Open session goes to the exact moment, in Chat's own query words", () => {
  // chat/session.js reads ?at=&ask=&tool=; chat/lib/routes.js spells the two paths.
  assert.equal(sessionHref({ kind: "ask", id: "a1", at: 5, thread: "t1", project: "harlow-legal", anchor: { tool_use_id: "toolu_1", event: 9 } }),
    "/chat/harlow-legal/t1?at=5&ask=a1&tool=toolu_1");
  assert.equal(sessionHref({ kind: "question", id: "q 1", at: 5, thread: "t1", anchor: { tool_use_id: null, event: 9 } }), "/chat/thread/t1?at=5&ask=q%201");
  // A held draft: no ask id; its anchor's thread and time.
  assert.equal(sessionHref({ kind: "draft", id: "g1", at: 5, thread: null, anchor: { thread: "t2", at: 7, event: null } }), "/chat/thread/t2?at=7");
  assert.equal(sessionHref({ kind: "draft", at: 5, thread: null }), null);
});

test("need-rows: a released swipe commits past 100 or on a fling, else stays open or closes", () => {
  assert.equal(release(120, 0), "commit-right");
  assert.equal(release(60, 0.8), "commit-right");
  assert.equal(release(60, 0), "open-right");
  assert.equal(release(20, 0), "close");
  assert.equal(release(-101, 0), "commit-left");
  assert.equal(release(-50, -0.9), "commit-left");
  assert.equal(release(-50, 0.9), "open-left");
  assert.equal(release(0, 3), "close");
});

test("need-rows: a question's answers, chosen or typed", () => {
  const qs = [{ question: "Which firm first?" }, { question: "Which files?", multiSelect: true }];
  const picked = new Map([[0, new Set(["Harlow Legal"])], [1, new Set(["a.md", "b.md"])]]);
  assert.deepEqual(questionAnswers(qs, picked, new Map()), { "Which firm first?": "Harlow Legal", "Which files?": "a.md, b.md" });
  assert.deepEqual(questionAnswers(qs, picked, new Map([[0, " Northwind Bakery "]])), { "Which firm first?": "Northwind Bakery", "Which files?": "a.md, b.md" });
  assert.equal(questionAnswers(qs, new Map([[0, new Set(["x"])]]), new Map()), null);
});

test("need-rows: changes and push targets", () => {
  assert.deepEqual(changesLine({ totals: { files: 6, added: 412, removed: 38 } }), { files: "6 files", counts: "+412 -38" });
  assert.deepEqual(changesLine({ changes: [{ file: "a", added: 2, removed: 1 }] }), { files: "1 file", counts: "+2 -1" });
  assert.equal(changesLine({}), null);
  assert.deepEqual(pushTarget("git push origin q3-report"), { remote: "origin", branch: "q3-report" });
  assert.deepEqual(pushTarget("git push -u origin HEAD:q3-report"), { remote: "origin", branch: "q3-report" });
  assert.equal(pushTarget("npm test"), null);
});

test("need-rows: a committed swipe, by kind and side (the no-nag rule)", () => {
  const ask = { kind: "ask", at: 0 }, draft = { kind: "draft", at: 0, gate: { kind: "send" } }, q = { kind: "question", at: 0 }, pair = { kind: "pair", at: 0 };
  assert.equal(swipeCommit(ask, "right"), "approve");
  assert.equal(swipeCommit(ask, "left"), "deny");
  // A draft goes out as the person: the right swipe shows the final words first.
  assert.equal(swipeCommit(draft, "right"), "sheet");
  assert.equal(swipeCommit(draft, "left"), "discard");
  assert.equal(swipeCommit(q, "right"), "sheet");
  assert.equal(swipeCommit(q, "left"), "later");
  assert.equal(swipeCommit(pair, "right"), "sheet");
  assert.equal(swipeCommit(pair, "left"), "deny");
  assert.equal(SWIPE_HINT, "Swipe right to approve, left to deny.");
  assert.deepEqual(swipeActions({ kind: "draft", at: 0, gate: { kind: "spend" } }), ["Approve", "Discard"]);
  assert.deepEqual(swipeActions(ask), ["Approve", "Deny"]);
});

test("need-rows: the sheet's primary words", () => {
  assert.equal(sheetPrimary({ kind: "ask", at: 0 }, "Face ID"), "Approve");
  assert.equal(sheetPrimary({ kind: "draft", at: 0, gate: { kind: "send" } }, "Face ID"), "Send with Face ID");
  assert.equal(sheetPrimary({ kind: "draft", at: 0, gate: { kind: "send" } }, "Face ID", true), "Send edited");
  assert.equal(sheetPrimary({ kind: "draft", at: 0, gate: { kind: "spend" } }, "fingerprint"), "Approve with fingerprint");
  assert.equal(sheetPrimary({ kind: "question", at: 0 }, "Face ID"), "Answer");
  assert.equal(sheetPrimary({ kind: "pair", at: 0 }, "Touch ID"), "Pair with Touch ID");
  // A presence session covers it: no Face ID is asked, so none is named.
  assert.equal(sheetPrimary({ kind: "draft", at: 0, gate: { kind: "send" } }, "Face ID", false, true), "Send");
  assert.equal(sheetPrimary({ kind: "draft", at: 0, gate: { kind: "send" } }, "Face ID", true, true), "Send edited");
  assert.equal(sheetPrimary({ kind: "draft", at: 0, gate: { kind: "spend" } }, "Face ID", false, true), "Approve");
});

test("need-rows: toasts are honest about Undo", () => {
  assert.deepEqual(toastFor("approve"), { text: "Approved", undo: false });
  assert.deepEqual(toastFor("deny"), { text: "Denied", undo: true });
  assert.deepEqual(toastFor("discard"), { text: "Discarded", undo: true });
  assert.equal(toastFor("later").undo, true);
  assert.equal(toastFor("send").undo, false);
});

test("need-rows: held for, who asks, and fact rows", () => {
  assert.equal(heldFor(NOW - 4 * 60_000, NOW), "Held 4 min");
  assert.equal(heldFor(NOW - 10_000, NOW), "Held just now");
  assert.equal(heldFor(NOW - 2 * 3_600_000, NOW), "Held 2 h");
  assert.equal(heldFor(NOW - 86_400_000 * 3, NOW), "Held 3 days");
  assert.equal(sheetWho({ kind: "ask", at: 0, agent: "kit", projectName: "Harlow Legal" }), "kit asks · Harlow Legal");
  assert.equal(sheetWho({ kind: "draft", at: 0 }), "An agent asks");
  assert.deepEqual(factRows({ kind: "ask", at: 0, detail: { command: "git push origin q3-report", totals: { files: 6, added: 412, removed: 38 } }, rule: "pushes ask first" }), [
    { label: "Remote", value: "origin" }, { label: "Branch", value: "q3-report" }, { label: "Changes", value: "6 files", counts: "+412 -38" },
    { label: "Held by", value: "Your rule: pushes ask first" }]);
  assert.deepEqual(factRows({ kind: "ask", at: 0, command: "node deploy.js", destination: "https://api.example.com" }), [{ label: "Where", value: "https://api.example.com" }]);
  // An Edit's file is the command block already: no Where row saying it again.
  assert.deepEqual(factRows({ kind: "ask", at: 0, detail: { file: "/home/alex/harlow/menu.md" }, destination: "/home/alex/harlow/menu.md" }), []);
});

/** Timers the test moves by hand. */
function clock() {
  let now = 0, seq = 0;
  /** @type {Map<number, { at: number, f: () => void }>} */ const q = new Map();
  return {
    setTimeout: (/** @type {() => void} */ f, /** @type {number} */ ms) => { const id = ++seq; q.set(id, { at: now + ms, f }); return id; },
    clearTimeout: (/** @type {number} */ id) => { q.delete(id); },
    tick(/** @type {number} */ ms) { now += ms; for (const [id, t] of [...q]) if (t.at <= now) { q.delete(id); t.f(); } },
    get pending() { return q.size; },
  };
}

test("need-rows: a deny waits out its Undo toast, and Undo means it never ran", async () => {
  const t = clock();
  let ran = 0;
  const d = deferred(() => { ran++; return "ok"; }, 4000, t);
  t.tick(3999);
  assert.equal(ran, 0);
  assert.equal(d.cancel(), true);
  t.tick(10);
  assert.equal(ran, 0);
  assert.deepEqual(await d.done, { ran: false });
  assert.equal(t.pending, 0);

  const e = deferred(() => { ran++; return "sent"; }, 4000, t);
  t.tick(4000);
  assert.deepEqual(await e.done, { ran: true, value: "sent" });
  assert.equal(ran, 1);
  assert.equal(e.cancel(), false, "too late to undo once it ran");
});

test("need-rows: flush sends at once, once; a failure is reported, not thrown", async () => {
  const t = clock();
  let ran = 0;
  const d = deferred(() => { ran++; throw new Error("your server refused"); }, 4000, t);
  d.flush(); d.flush();
  t.tick(5000);
  const r = await d.done;
  assert.equal(ran, 1);
  assert.equal(r.ran, true);
  assert.equal(r.error.message, "your server refused");
  assert.equal(d.state, "ran");
});

test("need-rows: Later hides a question on this device for an hour", () => {
  const mem = new Map();
  const store = { getItem: (/** @type {string} */ k) => mem.get(k) ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => { mem.set(k, v); } };
  const s = snoozes(store);
  s.snooze("q1", NOW);
  assert.equal(s.has("q1", NOW + LATER_MS - 1), true);
  assert.equal(s.has("q2", NOW), false);
  assert.equal(s.has("q1", NOW + LATER_MS), false, "back after an hour");
  assert.equal(JSON.parse(mem.get("vyre.needs.later")).q1, undefined, "the expired entry is dropped");
  s.snooze("q3", NOW); s.wake("q3");
  assert.equal(s.has("q3", NOW), false);
  // A private window whose storage throws: nothing is hidden, and nothing throws.
  const broken = snoozes({ getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("SecurityError"); } });
  broken.snooze("q1");
  assert.equal(broken.has("q1"), false);
  assert.equal(snoozes(null).has("x"), false);
});

test("need-rows: a Mac session's ask swipes and approves like any other, and says which Mac", async () => {
  const { elsewhere, resetMacAnswers } = await import("./need-rows.js");
  resetMacAnswers();
  const mac = { kind: "ask", at: NOW, agent: "kit", tool: "Bash", command: "npm test", source: "mac", machine: "alex-mac" };
  assert.equal(elsewhere(mac), null);
  assert.deepEqual(swipeActions(mac), ["Approve", "Deny"]);
  assert.equal(swipeCommit(mac, "right"), "approve");
  assert.equal(swipeCommit(mac, "left"), "deny");
  assert.match(ariaLabel(mac, NOW), /Actions: Approve, Deny, Open\.$/);
  assert.equal(thirdLine(mac), "kit · on alex-mac");
  assert.equal(thirdLine({ ...mac, machine: null }), "kit · on your Mac");
  assert.equal(thirdLine({ ...mac, source: null }), "kit", "a server session says nothing of a Mac");
});

test("need-rows: on a server that cannot forward answers (pre-v2), a Mac's ask only opens and says where", async () => {
  const { elsewhere, holdMacAnswers, resetMacAnswers, macAnswers } = await import("./need-rows.js");
  const mac = { kind: "ask", at: NOW, agent: "kit", tool: "Bash", command: "npm test", source: "mac", machine: "alex-mac" };
  holdMacAnswers();
  try {
    assert.equal(macAnswers(), false);
    assert.equal(elsewhere(mac), "alex-mac");
    assert.equal(elsewhere({ ...mac, machine: null }), "your Mac");
    assert.equal(elsewhere({ ...mac, kind: "question" }), "alex-mac");
    assert.equal(elsewhere({ ...mac, source: null }), null, "a server session is answered here");
    assert.equal(elsewhere({ ...mac, kind: "draft" }), null, "a held draft is your server's");
    assert.deepEqual(swipeActions(mac), []);
    assert.deepEqual(swipeActions({ ...mac, source: null }), ["Approve", "Deny"]);
    assert.equal(swipeCommit(mac, "right"), "sheet");
    assert.equal(swipeCommit(mac, "left"), "sheet");
    assert.match(ariaLabel(mac, NOW), /Answer it on alex-mac\. Actions: Open\.$/);
    assert.doesNotMatch(ariaLabel(mac, NOW), /Approve/);
  } finally { resetMacAnswers(); }
  assert.equal(elsewhere(mac), null);
});

test("need-rows: a held request is said in words, never as a raw HTTP request", () => {
  const spend = { kind: "spend", via: "billing", summary: "POST https://api.example.com/v1/topups", draft: { method: "POST", url: "https://api.example.com/v1/topups", body: JSON.stringify({ account: "northwind-ads", amount_usd: 150 }) } };
  assert.equal(plainSummary(spend), "Spend 150 USD on northwind-ads through billing");
  assert.equal(secondLine({ kind: "draft", gate: spend }).text, "Spend 150 USD on northwind-ads through billing");
  assert.equal(plainSummary({ kind: "spend", via: "billing", summary: "POST https://x.test/y", draft: null }), "Spend money through billing");
  assert.equal(plainSummary({ kind: "delete", via: "drive", summary: "DELETE https://x.test/f/1", draft: null }), "Delete something through drive");
  assert.equal(plainSummary({ kind: "send", via: "mail", summary: "POST https://x.test/send", draft: null }), "Send a request through mail");
  assert.equal(plainSummary({ kind: "send", via: "mail", summary: "Email dana@harlowlegal.com", draft: null }), "Email dana@harlowlegal.com", "a plain summary is kept");
  assert.equal(thirdLine({ kind: "draft", agent: null, project: null, projectName: "Harlow Legal" }), "an agent · Harlow Legal", "no actor known: said honestly, never the assistant");
});

test("need-rows: a request's card facts are Through, Amount and the account; the raw request is not among them", () => {
  const g = { kind: "spend", via: "billing", draft: { method: "POST", url: "https://api.example.com/v1/topups", body: JSON.stringify({ account: "northwind-ads", amount_usd: 150 }) } };
  assert.deepEqual(requestFacts(g), [["Spend", "through billing"], ["Amount", "150 USD"], ["Account", "northwind-ads"]]);
  assert.deepEqual(requestFacts({ kind: "delete", via: "drive", draft: { method: "DELETE", url: "https://x.test/f" } }), [["Delete", "through drive"]]);
});
