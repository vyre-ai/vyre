// @ts-check
// The phone's Needs you rows: titles, lines, labels and swipe releases (docs/design/phone.md 4, 5, 12).

import test from "node:test";
import assert from "node:assert/strict";
import { askTitle, draftTitle, titleOf, secondLine, thirdLine, ago, agoLong, ariaLabel, presenceWord, sessionHref,
  release, questionAnswers, changesLine, pushTarget, swipeActions } from "./need-rows.js";

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

test("need-rows: Open session goes to the exact moment", () => {
  assert.equal(sessionHref({ kind: "ask", at: 5, thread: "t1", anchor: { tool_use_id: "toolu_1", event: 9 } }), "/chat/thread/t1?at=5&tool=toolu_1");
  assert.equal(sessionHref({ kind: "ask", at: 5, thread: "t1", anchor: { tool_use_id: null, event: 9 } }), "/chat/thread/t1?at=5&event=9");
  assert.equal(sessionHref({ kind: "draft", at: 5, thread: null, anchor: { thread: "t2", at: 7, event: null } }), "/chat/thread/t2?at=7");
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
