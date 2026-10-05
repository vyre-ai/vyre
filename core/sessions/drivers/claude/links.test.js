// @ts-check
// A turn's links: the files, commits and urls it touched, found from the transcript's tool calls and the turn's own words.

import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempHome } from "../../../../test/helpers.js";
import { read, fullTurns, CLIP } from "./transcripts.js";
import { toolLinks, textLinks, commitLinks, cleanLinks, pathRef, LINKS_PER_TURN } from "./links.js";

const CWD = "/work/app";
let n = 0;
const line = (type, message, extra = {}) => JSON.stringify({ type, cwd: CWD, timestamp: new Date(1e12 + ++n * 1000).toISOString(), message, ...extra });
const user = text => line("user", { role: "user", content: text });
const say = text => line("assistant", { role: "assistant", content: [{ type: "text", text }] });
const call = (id, name, input) => line("assistant", { role: "assistant", content: [{ type: "tool_use", id, name, input }] });
const result = (id, text, isError = false) => line("user", { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }] });

function transcript(t, lines) {
  const dir = tempHome(t);
  const file = path.join(dir, "s1.jsonl");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

test("links: a tool call's file, a read, and a url become links; other tools make none", () => {
  assert.deepEqual(toolLinks("Edit", { file_path: "/work/app/src/auth.ts" }, CWD), [{ kind: "file", ref: "src/auth.ts" }]);
  assert.deepEqual(toolLinks("Write", { file_path: "/elsewhere/x.md" }, CWD), [{ kind: "file", ref: "/elsewhere/x.md" }]);
  assert.deepEqual(toolLinks("NotebookEdit", { notebook_path: "/work/app/n.ipynb" }, CWD), [{ kind: "file", ref: "n.ipynb" }]);
  assert.deepEqual(toolLinks("Read", { file_path: "/work/app/README.md" }, CWD), [{ kind: "read", ref: "README.md" }]);
  assert.deepEqual(toolLinks("WebFetch", { url: "https://example.com/docs" }, CWD), [{ kind: "url", ref: "https://example.com/docs" }]);
  assert.deepEqual(toolLinks("Bash", { command: "ls" }, CWD), []);
  assert.deepEqual(toolLinks("Edit", {}, CWD), []);
  assert.equal(pathRef("/work/app", CWD), "/work/app", "the folder itself is not made empty");
});

test("links: commits are named by the word commit or a git bracket, and a number or a word is not a hash", () => {
  assert.deepEqual(textLinks("I made commit a1b2c3d and pushed.").map(l => l.ref), ["a1b2c3d"]);
  assert.deepEqual(textLinks("[main 9f8e7d6] fix the thing").map(l => l.ref), ["9f8e7d6"]);
  assert.deepEqual(textLinks("committed `1A2B3C4D5E`").map(l => l.ref), ["1a2b3c4d5e"], "case folds, backticks drop");
  assert.deepEqual(textLinks("commit 1234567 and commit deadbeef and the facade decade"), [], "all digits, all letters, and prose are not commits");
  assert.deepEqual(textLinks("see https://example.com/a?b=1, and (https://x.org/y).").map(l => l.ref), ["https://example.com/a?b=1", "https://x.org/y"]);
  assert.deepEqual(commitLinks("[feature/x (root-commit) 0a1b2c3] first\n 1 file changed").map(l => l.ref), ["0a1b2c3"]);
});

test("links: a ref that a redaction rule would change is dropped whole, duplicates go, and the count is capped", () => {
  const key = "sk-ant-api03-" + "A".repeat(40);
  assert.deepEqual(cleanLinks([{ kind: "url", ref: `https://x.org/?key=${key}` }, { kind: "file", ref: "a.ts" }, { kind: "file", ref: "a.ts" }]), [{ kind: "file", ref: "a.ts" }]);
  const many = Array.from({ length: LINKS_PER_TURN + 20 }, (_, i) => ({ kind: "file", ref: `f${i}.ts` }));
  assert.equal(cleanLinks(many).length, LINKS_PER_TURN);
});

test("read: tool calls link to the next assistant turn of the exchange, a git commit's printed hash too, and a person's turn closes the exchange", t => {
  const file = transcript(t, [
    user("fix the login bug"),
    say("Looking at auth."),                                         // seq 1
    call("t1", "Read", { file_path: "/work/app/src/auth.ts" }),
    call("t2", "Edit", { file_path: "/work/app/src/auth.ts" }),
    result("t2", "ok"),
    call("t3", "Bash", { command: "git add -A && git commit -m 'fix login'" }),
    result("t3", "[main c0ffee1] fix login\n 1 file changed"),
    say("Fixed, and committed as above."),                           // seq 2
    user("now the docs"),                                            // seq 3
    call("t4", "Write", { file_path: "/work/app/docs/login.md" }),
    result("t4", "ok"),
    user("never mind"),                                              // seq 4: closes the exchange; t4 goes to the assistant turn before (seq 2)
  ]);
  const tr = read(file);
  assert.ok(tr);
  const at = seq => (tr.turns[seq].links || []).map(l => `${l.kind}:${l.ref}`).sort();
  assert.deepEqual(at(1), [], "a tool call after a text turn does not link back to it while a later assistant turn will take it");
  assert.deepEqual(at(2), ["commit:c0ffee1", "file:docs/login.md", "file:src/auth.ts", "read:src/auth.ts"]);
  assert.equal(tr.turns.length, 5);
});

test("read: a tool call with an assistant turn on neither side hangs on nothing, and a tool_result that is not a commit adds nothing", t => {
  const file = transcript(t, [
    call("t1", "Edit", { file_path: "/work/app/a.ts" }),
    result("t1", "ok"),
    user("hello"),
    say("hi"),
  ]);
  const tr = read(file);
  assert.ok(tr);
  assert.deepEqual(tr.turns.flatMap(x => x.links || []), []);
});

test("fullTurns: a turn the index cut is read whole from the file, redacted, by the same seq read() counts", t => {
  const long = "word ".repeat(2000) + "THE END";
  const file = transcript(t, [user("short"), say(long), user("sk-ant-api03-" + "B".repeat(40) + " is my key")]);
  const tr = read(file);
  assert.ok(tr);
  assert.ok(tr.turns[1].text.length <= CLIP + 20, "the index keeps the first CLIP characters");
  assert.ok(!tr.turns[1].text.includes("THE END"));
  const full = fullTurns(file, [1, 2]);
  assert.ok(full.get(1)?.text.endsWith("THE END"), "the whole turn");
  assert.equal(full.get(1)?.cut, false);
  assert.ok(!full.get(2)?.text.includes("sk-ant-api03"), "redacted");
  assert.equal(fullTurns(file, [9]).size, 0, "a seq that is not there is not made up");
  assert.equal(fullTurns(path.join(path.dirname(file), "gone.jsonl"), [0]).size, 0);
});
