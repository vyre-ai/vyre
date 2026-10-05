// @ts-check
// The transcripts adapter: finding transcript files as Claude Code lays them out, and reading
// each into turns without ever throwing over a bad file or a bad line.

import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { list, read, turnOf, CLIP } from "./transcripts.js";
import { SESSIONS, writeTranscripts, expected } from "../../../../test/fixtures/corpus.js";
import { tempHome } from "../../../../test/helpers.js";

const user = (text, extra = {}) => ({ type: "user", timestamp: "2026-09-01T09:00:00Z", cwd: "/home/alex/Work/harlow-site", message: { role: "user", content: text }, ...extra });
const claude = (text, extra = {}) => ({ type: "assistant", timestamp: "2026-09-01T09:05:00Z", message: { role: "assistant", content: [{ type: "text", text }] }, ...extra });
const rename = name => ({ type: "custom-title", customTitle: name, sessionId: "x" });

function write(dir, rel, lines) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.map(l => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return f;
}

test("transcripts: list finds sessions and subagents, with the subagent's Vyre id", t => {
  const dir = path.join(tempHome(t), "transcripts");
  const { files } = writeTranscripts(dir);
  const found = list([dir, path.join(dir, "missing")]);
  assert.deepEqual(found.map(e => e.id).sort(), SESSIONS.map(s => s.id).sort());
  const sub = found.find(e => e.parent);
  assert.equal(sub?.id, "11111111-aaaa-4000-8000-000000000001/agent-a5ub");
  assert.equal(sub?.file, files[sub.id]);
  assert.deepEqual(list([path.join(dir, "nowhere")]), [], "a missing folder is no history, not an error");
});

test("transcripts: the same session in two folders is listed once, from the fullest copy", t => {
  const home = tempHome(t);
  const a = path.join(home, "projects"), b = path.join(home, "archive");
  write(a, "-x/s1.jsonl", [user("short copy")]);
  const full = write(b, "-y/s1.jsonl", [user("short copy"), claude("and the rest of the conversation")]);
  const found = list([a, b]);
  assert.equal(found.length, 1);
  assert.equal(found[0].file, full, "the shorter copy won, so the longer one's turns would be lost");
});

test("transcripts: things that are not transcripts are ignored", t => {
  const dir = path.join(tempHome(t), "projects");
  write(dir, "-x/notes.md", ["# not a transcript"]);
  fs.mkdirSync(path.join(dir, "-x", "scratch.jsonl"), { recursive: true });
  fs.writeFileSync(path.join(dir, "loose.jsonl"), "{}\n");
  write(dir, "-x/s2.jsonl", [user("still indexes")]);
  assert.deepEqual(list([dir]).map(e => e.id), ["s2"]);
});

test("transcripts: reading the corpus gives exactly the expected turns and session fields", t => {
  const dir = path.join(tempHome(t), "transcripts");
  writeTranscripts(dir);
  for (const e of list([dir])) {
    const s = SESSIONS.find(x => x.id === e.id);
    const want = expected(s);
    const got = read(e.file, { id: e.id, parent: e.parent });
    assert.ok(got);
    // links (what a turn touched, links.test.js) ride on a turn but are not part of what was said.
    assert.deepEqual(got.turns.map(({ links: _, ...x }) => ({ session: e.id, ...x })), want.turns, `${e.id}: turns differ`);
    for (const k of ["cwd", "name", "title", "started", "ended", "human", "parent"]) assert.equal(got[k], want.session[k], `${e.id}: ${k}`);
  }
});

test("transcripts: the corpus's tool call between two turns links the assistant turn before the person's next one", t => {
  const dir = path.join(tempHome(t), "transcripts");
  writeTranscripts(dir);
  const e = list([dir]).find(x => x.id === "11111111-aaaa-4000-8000-000000000001");
  const got = read(e.file, { id: e.id, parent: e.parent });
  assert.deepEqual(got?.turns.map(x => x.links || null), [null, [{ kind: "read", ref: "src/intake.tsx" }], null, null]);
});

test("transcripts: the last /rename wins, however many copies came before it", t => {
  const dir = tempHome(t);
  const f = write(dir, "-x/s.jsonl", [user("can you look at the quarterly deck"), rename("first"), rename("first"), claude("ok"), rename("Harlow Q3 deck"), claude("done")]);
  const r = read(f);
  assert.equal(r?.name, "Harlow Q3 deck");
  assert.equal(r?.title, "can you look at the quarterly deck", "the title stays the description");
  assert.equal(read(write(dir, "-x/n.jsonl", [user("no rename here"), claude("fine")]))?.name, null);
});

test("transcripts: tool traffic, thinking and lines Claude Code adds are not turns", () => {
  assert.equal(turnOf({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: {} }] } }), null);
  assert.equal(turnOf({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } }), null);
  assert.equal(turnOf({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "file contents" }] } }), null);
  assert.equal(turnOf({ type: "user", isMeta: true, message: { role: "user", content: "Caveat: generated by a local command" } }), null);
  assert.equal(turnOf({ type: "system", content: "hook ran" }), null);
  assert.equal(turnOf({ type: "user", message: { role: "user", content: "   " } }), null);
  assert.deepEqual(turnOf({ type: "user", message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image" }] } }), { role: "user", text: "look" });
});

test("transcripts: torn and invalid lines cost those lines and nothing else", t => {
  const dir = tempHome(t);
  const f = path.join(dir, "s.jsonl");
  fs.writeFileSync(f, [JSON.stringify(user("before the corruption")), "{ this is not json }", "42", "null",
    JSON.stringify(claude("after the corruption"))].join("\n") + "\n" + '{"type":"assistant","mess');
  const r = read(f);
  assert.deepEqual(r?.turns.map(x => x.text), ["before the corruption", "after the corruption"]);
  assert.equal(r?.bad, 2);
  assert.equal(read(path.join(dir, "absent.jsonl")), null, "a missing file must be null, not a throw");
  fs.writeFileSync(path.join(dir, "empty.jsonl"), "");
  fs.writeFileSync(path.join(dir, "blank.jsonl"), "\n\n   \n");
  for (const n of ["empty", "blank"]) {
    const e = read(path.join(dir, n + ".jsonl"));
    assert.equal(e?.turns.length, 0);
    assert.equal(e?.title, null);
  }
});

test("transcripts: the real cwd comes from the lines, and a program's session is not human", t => {
  const dir = tempHome(t);
  // "harlow-site" and "harlow/site" encode to the same folder name; only the lines know which.
  const f = write(dir, "-home-alex-Work-harlow-site/s.jsonl", [user("hello", { cwd: "/home/alex/Work/harlow-site", entrypoint: "cli" })]);
  assert.equal(read(f)?.cwd, "/home/alex/Work/harlow-site");
  assert.equal(read(f)?.human, 1);
  const sdk = write(dir, "-x/sdk.jsonl", [user("summarise", { entrypoint: "sdk-cli" })]);
  assert.equal(read(sdk)?.human, 0);
  const side = write(dir, "-x/side.jsonl", [user("audit", { isSidechain: true })]);
  assert.equal(read(side)?.human, 0);
});

test("transcripts: text is redacted and clipped before it leaves, titles and names too", t => {
  const dir = tempHome(t);
  const tok = "ghp_" + "Ab3".repeat(14);
  const f = write(dir, "-x/s.jsonl", [
    user("rotate this token please: " + tok), rename("key " + tok),
    claude("LOGSTART " + "x".repeat(200_000) + " LOGEND"), claude("the token is " + tok + " and it expires friday"),
  ]);
  const r = read(f);
  const all = JSON.stringify(r);
  assert.ok(!all.includes("Ab3Ab3Ab3"), "a token left the adapter");
  assert.match(r?.title || "", /rotate this token please/);
  assert.ok(r?.turns[1].text.length <= CLIP, "a 200KB line went out whole");
  assert.ok(r?.turns[2].text.includes("expires friday"));
  assert.equal(r?.redacted, 2, "the count is of secrets taken out of turns");
});

test("transcripts: a title skips command echoes and injected context", t => {
  const dir = tempHome(t);
  const f = write(dir, "-x/s.jsonl", [user("<command-name>/clear</command-name>"), user("ok"), user("Fix the Northwind invoice total"), claude("done")]);
  assert.equal(read(f)?.title, "Fix the Northwind invoice total");
});

test("transcripts: an assistant turn carries the model that wrote it, a person's turn none", t => {
  const dir = path.join(tempHome(t), "transcripts");
  const f = write(dir, "-tmp-p/m1.jsonl", [user("hello"), claude("hi", { message: { role: "assistant", model: "claude-opus-4-1", content: [{ type: "text", text: "hi" }] } })]);
  const turns = read(f).turns;
  assert.deepEqual(turns.map(x => [x.role, x.model ?? null]), [["user", null], ["assistant", "claude-opus-4-1"]]);
});
