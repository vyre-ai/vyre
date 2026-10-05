// @ts-check
// The chat tools (the Deck's composer, session, undo-sheet, tag-picker and PR card calls, ported) over a fake box: every tool name and input is the Deck's.
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

test("modes and effort: three modes walked, bypass never offered, the words a person reads", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  assert.deepEqual(m.modesOf(null), ["default", "acceptEdits", "plan"]);
  assert.deepEqual(m.modesOf(["plan", "bypassPermissions", "default"]), ["default", "plan"]);
  assert.equal(m.modeLabel("acceptEdits"), "Accepts edits");
  assert.equal(m.modeLabel(null), "Asks first");
  assert.equal(m.effortLabel(null), "Default");
  assert.equal(m.effortLabel("xhigh"), "Extra high");
});

test("effort, thinking and mode send the Deck's inputs; a not-running answer is a reason, not a change", { skip: !strip }, async () => {
  const { chatToolsSource } = await import("./source.ts");
  const b = box({ "threads.thinking": { data: { thinking: null, note: "Thinking switches on a running session." } }, "threads.mode": { data: { mode: "plan" } } });
  const s = chatToolsSource(b.call);
  assert.deepEqual(await s.effort("t1", "high"), { ok: true });
  assert.deepEqual(await s.effort("t1", null), { ok: true });
  assert.deepEqual(await s.thinking("t1", true), { ok: false, reason: "Thinking switches on a running session." });
  assert.deepEqual(await s.mode("t1", "plan"), { ok: true });
  assert.deepEqual(b.seen.map((x) => [x.tool, x.input]), [
    ["threads.effort", { thread: "t1", effort: "high" }], ["threads.effort", { thread: "t1" }],
    ["threads.thinking", { thread: "t1", on: true }], ["threads.mode", { thread: "t1", mode: "plan" }]]);
});

test("fork answers the new thread; a box that refuses gives its words", { skip: !strip }, async () => {
  const { chatToolsSource } = await import("./source.ts");
  const s = chatToolsSource(box({ "threads.fork": { data: { thread: "t2" } } }).call);
  assert.deepEqual(await s.fork("t1"), { ok: true, thread: "t2" });
  const r = await chatToolsSource(box({ "threads.fork": { error: { code: "busy", message: "It is busy." } } }).call).fork("t1", "u9");
  assert.deepEqual(r, { ok: false, reason: "It is busy." });
});

test("send now names the queued row; already sent is said, not hidden", { skip: !strip }, async () => {
  const { chatToolsSource } = await import("./source.ts");
  const b = box({ "threads.send-now": { data: { sent: false, note: "It was already sent." } } });
  const s = chatToolsSource(b.call);
  assert.deepEqual(await s.sendNow("t1", 7), { ok: false, reason: "It was already sent." });
  assert.deepEqual(b.seen[0], { tool: "threads.send-now", input: { thread: "t1", queued: 7 } });
});

test("tasks: running first, Stop only on a running one; stop sends the task id", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  const rows = m.tasksOf({ tasks: [{ id: "a", title: "build", status: "done" }, { id: "b", description: "tests", status: "running" }, { nope: 1 }] });
  assert.deepEqual(rows.map((t) => t.id), ["b", "a"]);
  assert.equal(m.taskLive(rows[0]), true);
  assert.equal(m.taskLive(rows[1]), false);
  const { chatToolsSource } = await import("./source.ts");
  const b = box();
  await chatToolsSource(b.call).stopTask("t1", "b");
  assert.deepEqual(b.seen[0], { tool: "threads.kill-task", input: { thread: "t1", task: "b" } });
});

test("mentions: groups flatten, people first, an unnamed result is dropped; the draft text is @ for a teammate and # for the rest", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  const rows = m.mentionsOf({ groups: [{ kind: "drive", results: [{ id: "f1", name: "Intake form", hint: "Drive" }, { id: "x" }] }, { kind: "teammate", results: [{ id: "juno", name: "juno" }] }] });
  assert.deepEqual(rows.map((r) => r.name), ["juno", "Intake form"]);
  assert.equal(m.mentionText(rows[0]), "@juno ");
  assert.equal(m.mentionText(rows[1]), "#Intake-form ");
  const { chatToolsSource } = await import("./source.ts");
  const b = box({ "mentions.search": { data: { results: [] } } });
  await chatToolsSource(b.call).mentions("ju");
  assert.deepEqual(b.seen[0], { tool: "mentions.search", input: { q: "ju", limit: 30 } });
});

test("context: reports where the person is, then reads only what is known", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  assert.deepEqual(m.contextLines({ project: "intake", cwd: "", view: "chat", tz: "UTC" }), [{ label: "Project", value: "intake" }, { label: "Screen", value: "chat" }]);
  const { chatToolsSource } = await import("./source.ts");
  const b = box({ "context.now": { data: { project: "intake" } } });
  const d = await chatToolsSource(b.call).context("t1", "intake", "/w");
  assert.equal(d.project, "intake");
  assert.deepEqual(b.seen.map((x) => x.tool), ["context.report", "context.now"]);
  assert.deepEqual(b.seen[0].input, { surface: "chat", view: "chat", thread: "t1", project: "intake", cwd: "/w" });
});

test("transcript: user, assistant, thinking and tool blocks become short lines, long text cut", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  const lines = m.transcriptLines({ blocks: [{ type: "user", text: "hi" }, { type: "text", text: "x".repeat(400) }, { type: "tool", name: "files.read" }, { type: "image" }, null] });
  assert.deepEqual(lines.map((l) => l.who), ["you", "assistant", "tool"]);
  assert.equal(lines[1].text.length, 280);
});

test("go back: history cleaned, undo past a commit counts it and the newer ones, redo and the words", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  const h = m.historyOf({ commits: [{ sha: "c3", subject: "c" }, { sha: "c2" }, { sha: "c1", subject: "a" }, { subject: "no sha" }], dirty: 2 });
  assert.equal(h.commits.length, 3);
  assert.equal(h.commits[1].subject, "(no message)");
  assert.equal(m.takesOff(h.commits, "c2"), 2);
  assert.equal(m.takesOff(h.commits, null), 3);
  assert.equal(m.undoneLine({ undone: 1, kept_unsaved: true }), "Took off 1 change, and kept your unsaved work with it.");
  assert.equal(m.undoneLine({}), "Nothing to take off.");
  const { chatToolsSource } = await import("./source.ts");
  const b = box({ "github.session.undo": { data: { undone: 2 } }, "github.session.redo": { data: { redone: 1 } } });
  const s = chatToolsSource(b.call);
  assert.deepEqual(await s.undo("p", "s", "c2"), { ok: true, note: "Took off 2 changes." });
  assert.deepEqual(await s.redo("p", "s"), { ok: true, note: "Put back 1 change." });
  assert.deepEqual(b.seen.map((x) => x.input), [{ project: "p", session: "s", to: "c2" }, { project: "p", session: "s" }]);
});

test("pull request: merge needs no words, a review does; the review event is the box's own", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  assert.deepEqual(m.prCall("merge", { project: "p", pr: 4 }, ""), { tool: "github.project.pr.merge", input: { project: "p", pr: 4 } });
  assert.deepEqual(m.prCall("changes", { project: "p", pr: 4 }, "  "), { problem: "Say what to change." });
  assert.deepEqual(m.prCall("comment", { project: "p", pr: 4 }, " ok ", 9), { tool: "github.project.pr.review", input: { project: "p", pr: 4, event: "COMMENT", body: "ok", in_reply_to: 9 } });
  const { chatToolsSource } = await import("./source.ts");
  const b = box();
  assert.deepEqual(await chatToolsSource(b.call).pr("changes", { project: "p", pr: 4 }, ""), { ok: false, reason: "Say what to change." });
  assert.equal(b.seen.length, 0, "nothing is sent for an empty review");
});

test("shared: artifacts as rows; a share answers the link whichever shape; a refusal is the box's words", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  assert.deepEqual(m.sharedRows([{ id: "a1", title: "Plan", kind: "page", shared: true }, { id: "a2" }, {}]).map((r) => [r.id, r.title, r.shared]), [["a1", "Plan", true], ["a2", "a2", false]]);
  assert.equal(m.linkOf("https://x/y"), "https://x/y");
  assert.equal(m.linkOf({ link: "https://x/z" }), "https://x/z");
  assert.equal(m.linkOf({}), "");
  const { chatToolsSource } = await import("./source.ts");
  const ok = box({ "artifacts.share": { data: { url: "https://x/a" } } });
  assert.deepEqual(await chatToolsSource(ok.call).share("a1", "7d"), { ok: true, url: "https://x/a" });
  assert.deepEqual(ok.seen[0], { tool: "artifacts.share", input: { id: "a1", expires: "7d" } });
  const no = await chatToolsSource(box({ "artifacts.share": { error: { code: "public_off", message: "public links are off" } } }).call).share("a1");
  assert.deepEqual(no, { ok: false, reason: "public links are off" });
});
