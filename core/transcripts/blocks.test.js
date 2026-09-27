// @ts-check
// blocks(): the rich read of one session the Deck's Chat renders. A realistic transcript in the
// sample world (fixtures/rich.jsonl), plus generated ones for paging, live files and big files.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { blocks, BLOCK_CAP, THINK_CAP } from "./index.js";
import { tempHome } from "../../test/helpers.js";
import { translate } from "../switchboard/translate.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const RICH = path.join(FIX, "rich.jsonl");
const at = (/** @type {string} */ s) => Date.parse(s);

test("blocks: a real-shaped session reads as user, thinking, text, tools and turns", () => {
  const { blocks: bs, next, first } = blocks(RICH, { from: 0 });
  assert.deepEqual(bs.map(b => `${b.seq}:${b.kind}`), [
    "2:user", "3:user", "4:user", "5:thinking", "6:text", "7:tool", "10:tool", "12:tool", "14:tool", "16:tool",
    "18:text", "20:turn", "20:user", "21:text", "21:turn",
  ]);
  assert.equal(first, 2);
  assert.equal(next, 20, "the open turn starts at line 20, so a live read goes back there");
  const by = (/** @type {number} */ seq, /** @type {string} */ kind) => /** @type {any} */ (bs.find(b => b.seq === seq && b.kind === kind));

  // Command echoes are marked; a system reminder is gone; the pasted key is redacted.
  assert.equal(by(2, "user").command, true);
  assert.equal(by(3, "user").command, true);
  const prompt = by(4, "user");
  assert.equal(prompt.command, undefined);
  assert.doesNotMatch(prompt.text, /system-reminder|Context from kit/);
  assert.match(prompt.text, /Fix the order form on the Northwind Bakery site/);
  assert.match(prompt.text, /\[Stripe key redacted …ke12\]/);
  assert.ok(!JSON.stringify(bs).includes("NorthwindBakery0000fake"), "a pasted key left the read");
  assert.equal(prompt.ts, at("2026-09-02T10:01:00.000Z"));
  assert.equal(prompt.uuid, "u0004", "a person's block carries its line's uuid");

  assert.equal(by(5, "thinking").text, "juno said the form breaks on submit. Read the component first.");
  assert.equal(by(5, "thinking").block, 0);
  // msg_01A is written as three lines (thinking, text, tool_use): the text is its block 1.
  assert.deepEqual(by(6, "text"), { seq: 6, kind: "text", ts: at("2026-09-02T10:01:04.000Z"), message: "msg_01A", block: 1, text: "Let me look at the order form." });

  const read = by(7, "tool");
  assert.equal(read.tool, "Read");
  assert.equal(read.input.file_path, "/home/alex/Work/northwind-bakery/src/OrderForm.js");
  assert.match(read.output, /export function OrderForm/);
  assert.match(read.output, /\[image\]$/, "an image in a tool_result array is named");
  assert.equal(read.error, false);
  assert.equal(read.done_ts, at("2026-09-02T10:01:05.250Z"));
  assert.equal(read.duration_ms, 250);

  const edit = by(10, "tool");
  assert.equal(edit.tool, "Edit");
  assert.equal(edit.input.new_string, "return submit(validate(order));");
  assert.deepEqual(edit.patch[0].lines, [" export function OrderForm() {", "-  return submit(order);", "+  return submit(validate(order));", " }"]);

  const ok = by(12, "tool"), bad = by(14, "tool");
  assert.equal(ok.input.command, "npm test");
  assert.match(ok.output, /# pass 12/);
  assert.equal(ok.duration_ms, 3000);
  assert.equal(bad.error, true);
  assert.equal(bad.output, "Error: missing STRIPE_KEY for deploy");

  const todo = by(16, "tool");
  assert.equal(todo.tool, "TodoWrite");
  assert.deepEqual(todo.input.todos.map(t => t.status), ["completed", "pending"]);

  // The turn: from the prompt to the last reply line, tokens once per message (the last usage).
  assert.deepEqual(by(20, "turn"), { seq: 20, kind: "turn", ts: at("2026-09-02T10:01:00.000Z"), duration_ms: 20_000,
    tokens: { input: 8360, output: 225 }, model: "claude-sonnet-4-5" });
  assert.deepEqual(by(21, "turn"), { seq: 21, kind: "turn", ts: at("2026-09-02T10:02:00.000Z"), duration_ms: 4000,
    tokens: { input: 1705, output: 15 }, model: "claude-opus-4-1", open: true });

  // Neither the sidechain nor the meta lines show.
  assert.ok(!JSON.stringify(bs).includes("subagent chatter"));
  assert.ok(!bs.some(b => b.seq === 1 || b.seq === 9 || b.seq === 19));
});

test("blocks: without from it is the file's tail, and before pages back", () => {
  const all = blocks(RICH, { from: 0 }).blocks;
  const tail = blocks(RICH, { limit: 4 });
  assert.deepEqual(tail.blocks, all.slice(-4));
  assert.equal(tail.first, 20);
  const back = blocks(RICH, { before: /** @type {number} */ (tail.first), limit: 3 });
  // The page before line 20 reads on to line 20 to close its turn, so the turn comes with it.
  assert.deepEqual(back.blocks.map(b => `${b.seq}:${b.kind}`), ["16:tool", "18:text", "20:turn"]);
  assert.deepEqual(back.blocks[2], all.find(b => b.seq === 20 && b.kind === "turn"));
  assert.equal(back.next, 20);
  const whole = blocks(RICH, {});
  assert.deepEqual(whole.blocks, all, "a small session's tail is all of it");
});

test("blocks: a window that ends mid-turn still gets its results and its turn", () => {
  const w = blocks(RICH, { from: 0, limit: 6 });
  assert.deepEqual(w.blocks.map(b => `${b.seq}:${b.kind}`), ["2:user", "3:user", "4:user", "5:thinking", "6:text", "7:tool", "20:turn"]);
  assert.match(/** @type {any} */ (w.blocks[5]).output, /OrderForm/);
  assert.equal(w.next, 8);
  const rest = blocks(RICH, { from: w.next });
  assert.ok(!rest.blocks.some(b => b.seq === 20 && b.kind === "turn"), "the turn was the earlier read's; emitted twice it would count twice");
  assert.equal(rest.blocks[0].seq, 10);
});

/** A generated session file. */
function write(t, lines, tail = "\n") {
  const f = path.join(tempHome(t), "s.jsonl");
  fs.writeFileSync(f, lines.map(l => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + tail);
  return f;
}
const U = (text, ts) => ({ type: "user", timestamp: ts, message: { role: "user", content: text } });
const A = (id, part, ts, usage = { input_tokens: 1, output_tokens: 1 }) => ({ type: "assistant", timestamp: ts, message: { id, role: "assistant", model: "m", content: [part], usage } });
const R = (id, content, ts) => ({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } });

test("blocks: a live session resumes at its open turn, and a half-written line is left for later", t => {
  const lines = [
    U("run the Harlow Legal tests", "2026-09-03T08:00:00Z"),
    A("m1", { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }, "2026-09-03T08:00:01Z"),
  ];
  const f = write(t, lines, "\n" + '{"type":"user","timestamp":"2026-09-03T08:00:0');
  const one = blocks(f, { from: 0 });
  const tool = /** @type {any} */ (one.blocks.find(b => b.kind === "tool"));
  assert.equal(tool.output, null, "no result yet");
  assert.equal(one.next, 0, "the turn is open, so the next read starts at its human line");
  fs.writeFileSync(f, [...lines, R("t1", "ok", "2026-09-03T08:00:04Z"), A("m2", { type: "text", text: "all green" }, "2026-09-03T08:00:05Z"), U("thanks", "2026-09-03T08:01:00Z")]
    .map(l => JSON.stringify(l)).join("\n") + "\n");
  const two = blocks(f, { from: one.next });
  const done = /** @type {any} */ (two.blocks.find(b => b.kind === "tool"));
  assert.equal(done.output, "ok");
  assert.equal(done.duration_ms, 3000);
  const turn = /** @type {any} */ (two.blocks.find(b => b.kind === "turn" && !b.open));
  assert.deepEqual([turn.seq, turn.duration_ms, turn.tokens], [4, 5000, { input: 2, output: 2 }]);
  assert.equal(two.next, 5, "nothing is open any more, so the next read starts after the file");
});

test("blocks: caps and redaction on tool input, output, thinking and Write content", t => {
  const big = "x".repeat(BLOCK_CAP * 5);
  const todos = Array.from({ length: 3 }, (_, i) => ({ content: "y".repeat(BLOCK_CAP + 10) + i, status: "pending" }));
  const tok = "gh" + "p_" + "a".repeat(36);
  const f = write(t, [
    U("go", "2026-09-03T09:00:00Z"),
    A("m", { type: "thinking", thinking: "z".repeat(THINK_CAP * 2) }, "2026-09-03T09:00:01Z"),
    A("m", { type: "tool_use", id: "w", name: "Write", input: { file_path: "/home/alex/a.txt", content: `${tok}\n${big}` } }, "2026-09-03T09:00:02Z"),
    R("w", `wrote ${tok} ${big}`, "2026-09-03T09:00:03Z"),
    A("m", { type: "tool_use", id: "td", name: "TodoWrite", input: { todos } }, "2026-09-03T09:00:04Z"),
  ]);
  const bs = /** @type {any[]} */ (blocks(f, { from: 0 }).blocks);
  const think = bs.find(b => b.kind === "thinking"), w = bs.find(b => b.id === "w"), td = bs.find(b => b.id === "td");
  assert.ok(think.text.length < THINK_CAP + 40);
  assert.ok(w.input.content.length < BLOCK_CAP + 40, "a whole Write content came back");
  assert.ok(w.output.length < BLOCK_CAP + 40);
  assert.ok(!JSON.stringify(bs).includes(tok), "a token in tool traffic left the read");
  assert.match(w.input.content, /GitHub token redacted/);
  assert.equal(td.input.todos[2].content.length, BLOCK_CAP + 11, "todos are kept whole");
});

test("blocks: a big file reads its tail and from far in without trouble", t => {
  const lines = [];
  for (let i = 0; i < 20000; i++) {
    lines.push(U(`question ${i} from alex`, new Date(Date.UTC(2026, 8, 4, 0, 0, i)).toISOString()));
    lines.push(A(`m${i}`, { type: "text", text: `answer ${i}` }, new Date(Date.UTC(2026, 8, 4, 0, 0, i, 500)).toISOString()));
  }
  const f = write(t, lines);
  const tail = blocks(f, { limit: 3 });
  assert.deepEqual(tail.blocks.map(b => `${b.seq}:${b.kind}`), ["39998:user", "39999:text", "39999:turn"]);
  assert.equal(tail.first, 39998);
  assert.equal(tail.next, 39998);
  const back = blocks(f, { before: 39998, limit: 3 });
  assert.deepEqual(back.blocks.map(b => `${b.seq}:${b.kind}`), ["39996:user", "39997:text", "39998:turn"]);
  const mid = blocks(f, { from: 30000, limit: 2 });
  assert.deepEqual(mid.blocks.map(b => `${b.seq}:${b.kind}`), ["30000:user", "30001:text", "30002:turn"]);
  assert.equal(mid.next, 30002);
});

test("blocks: a missing file is no blocks, never an error", () => {
  assert.deepEqual(blocks("/nowhere/at/all.jsonl", { from: 5 }), { blocks: [], next: 5, first: null });
  assert.deepEqual(blocks("/nowhere/at/all.jsonl"), { blocks: [], next: 0, first: null });
});

test("blocks: words typed while the model works are a steer inside its turn, with the step they joined at", t => {
  const f = write(t, [
    U("Rebuild the Harlow Legal intake", "2026-09-03T08:00:00Z"),
    A("m1", { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/intake/general.ts" } }, "2026-09-03T08:00:01Z"),
    R("t1", "1\texport const general = {};", "2026-09-03T08:00:02Z"),
    A("m2", { type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }, "2026-09-03T08:00:03Z"),
    { ...U("Use Estate intake v2 instead", "2026-09-03T08:00:04Z"), uuid: "steer-1" },
    R("t2", "ok", "2026-09-03T08:00:05Z"),
    A("m3", { type: "text", text: "Switching to the v2 form." }, "2026-09-03T08:00:06Z"),
    U("Thanks, now push q3-report", "2026-09-03T08:01:00Z"),
    A("m4", { type: "text", text: "Pushed." }, "2026-09-03T08:01:02Z"),
  ]);
  const bs = /** @type {any[]} */ (blocks(f, { from: 0 }).blocks);
  assert.deepEqual(bs.map(b => `${b.seq}:${b.kind}`), ["0:user", "1:tool", "3:tool", "4:user", "6:text", "7:turn", "7:user", "8:text", "8:turn"]);
  const steer = bs.find(b => b.seq === 4);
  assert.deepEqual([steer.steered, steer.step, steer.uuid, steer.text], [true, 1, "steer-1", "Use Estate intake v2 instead"], "one call had finished");
  const closed = bs.find(b => b.kind === "turn" && !b.open);
  assert.deepEqual([closed.seq, closed.duration_ms], [7, 6000], "the steer starts no turn: the first turn runs on to its reply");
  assert.equal(bs.find(b => b.seq === 7 && b.kind === "user").steered, undefined, "after the reply, a new turn");
});

test("blocks: a live read of an open turn keeps its steer, and resumes at the turn's first line", t => {
  const f = write(t, [
    U("Draft the Northwind Bakery menu", "2026-09-03T09:00:00Z"),
    A("m1", { type: "tool_use", id: "t1", name: "Read", input: { file_path: "menu.md" } }, "2026-09-03T09:00:01Z"),
    { ...U("Keep the prices as they are", "2026-09-03T09:00:02Z"), uuid: "s-2" },
  ]);
  const one = blocks(f, { from: 0 });
  const steer = /** @type {any} */ (one.blocks.find(b => b.kind === "user" && b.seq === 2));
  assert.deepEqual([steer.steered, steer.step], [true, 0], "the Read was still running");
  assert.equal(one.next, 0);
  assert.deepEqual(blocks(f, { from: one.next }).blocks.filter(b => /** @type {any} */ (b).steered).map(b => b.seq), [2], "the same on a re-read");
});

test("blocks: an interrupt ends the turn; neither it nor what follows is a steer", t => {
  const f = write(t, [
    U("Run the Northwind Bakery build", "2026-09-03T10:00:00Z"),
    A("m1", { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm run build" } }, "2026-09-03T10:00:01Z"),
    { type: "user", timestamp: "2026-09-03T10:00:02Z", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "t1", content: "Interrupted", is_error: true },
      { type: "text", text: "[Request interrupted by user for tool use]" }] } },
    U("Try the dev build instead", "2026-09-03T10:00:03Z"),
  ]);
  const bs = /** @type {any[]} */ (blocks(f, { from: 0 }).blocks);
  assert.ok(!bs.some(b => b.steered));
  assert.equal(bs.filter(b => b.kind === "user").length, 3);
});

// ------------------------------------------------------------ live keys equal transcript keys

/** The (message, block) keys the live stream gives, done and partial, from stream-json lines. */
function liveKeys(/** @type {string} */ file) {
  const seen = new Map();
  let message = "";
  const done = [], deltas = new Map();
  for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const t = translate(JSON.parse(line), seen);
    if (t.message !== undefined) message = t.message;
    if (t.delta) deltas.set(`${message}#${t.block}`, (deltas.get(`${message}#${t.block}`) || "") + t.delta);
    for (const e of t.events) if (e.type === "thread.text") done.push(e.payload);
  }
  return { done, deltas };
}

test("blocks: a message written as text, tool_use, text keeps each text's content block index", () => {
  const bs = /** @type {any[]} */ (blocks(path.join(FIX, "split.jsonl"), { from: 0 }).blocks);
  assert.deepEqual(bs.filter(b => b.kind === "text" || b.kind === "thinking").map(b => [b.kind, b.message ?? null, b.block]), [
    ["thinking", null, 0], ["text", "msg_03A", 1], ["text", "msg_03A", 3], ["text", "msg_03B", 0],
  ]);
  assert.equal(bs[0].uuid, "u0301");
  // A read that starts inside msg_03A (its last line) counts the lines before the window.
  const mid = /** @type {any[]} */ (blocks(path.join(FIX, "split.jsonl"), { from: 4 }).blocks);
  assert.deepEqual(mid.filter(b => b.kind === "text").map(b => [b.message, b.block]), [["msg_03A", 3], ["msg_03B", 0]]);
});

test("blocks: the live stream's keys (message, block) equal the transcript's for every text", () => {
  const tx = /** @type {any[]} */ (blocks(path.join(FIX, "split.jsonl"), { from: 0 }).blocks).filter(b => b.kind === "text");
  const { done, deltas } = liveKeys(path.join(FIX, "split.stream.jsonl"));
  const keys = (/** @type {any[]} */ xs) => xs.map(x => `${x.message}#${x.block}`);
  assert.deepEqual(keys(done), keys(tx), "a done text is keyed as its transcript block");
  assert.deepEqual([...deltas.keys()], keys(tx), "the deltas of each text are keyed as its transcript block");
  for (const b of tx) {
    assert.equal(deltas.get(`${b.message}#${b.block}`), b.text, "the deltas of one block add up to its text, and only its");
    assert.equal(done.find(d => d.message === b.message && d.block === b.block).text, b.text);
  }
  // Without the count, two texts of one message would share a key and the second overwrite the first.
  assert.equal(new Set(keys(done)).size, done.length);
});

test("blocks: a rewind's abandoned branch (two person's lines under one parent) is skipped, before and after paging", t => {
  const P = (/** @type {string|null} */ parent, /** @type {string} */ uuid, /** @type {any} */ line) => ({ parentUuid: parent, ...line, uuid });
  const f = write(t, [
    P(null, "a1", U("Read the Harlow Legal intake folder", "2026-09-03T10:00:00Z")),
    P("a1", "a2", A("m1", { type: "text", text: "It has three forms." }, "2026-09-03T10:00:01Z")),
    // The message rewound to, and what followed it: a branch the session no longer follows.
    P("a2", "b1", U("Rebuild the Estate intake", "2026-09-03T10:01:00Z")),
    P("b1", "b2", A("m2", { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "src/intake/estate.ts" } }, "2026-09-03T10:01:01Z")),
    P("b2", "b3", R("t1", "ok", "2026-09-03T10:01:02Z")),
    P("b3", "b4", A("m3", { type: "text", text: "Rebuilt." }, "2026-09-03T10:01:03Z")),
    // After the rewind: the next message is a second child of a2.
    P("a2", "c1", U("Rebuild it as Estate intake v2", "2026-09-03T10:02:00Z")),
    P("c1", "c2", A("m4", { type: "text", text: "On it." }, "2026-09-03T10:02:01Z")),
  ]);
  const bs = /** @type {any[]} */ (blocks(f, { from: 0 }).blocks);
  assert.deepEqual(bs.map(b => `${b.seq}:${b.kind}`), ["0:user", "1:text", "6:turn", "6:user", "7:text", "7:turn"]);
  assert.ok(!bs.some(b => b.kind === "tool" || /Rebuil(d the|t\.)/.test(b.text || "")), "nothing of the old branch");
  assert.deepEqual(blocks(f, {}).blocks.map(b => `${b.seq}:${b.kind}`), ["0:user", "1:text", "6:turn", "6:user", "7:text", "7:turn"], "the tail read too");
  // A tool's results under one parent are not a branch: only two person's lines are.
  const g = write(t, [
    P(null, "x1", U("Run the Northwind Bakery tests", "2026-09-03T11:00:00Z")),
    P("x1", "x2", A("n1", { type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }, "2026-09-03T11:00:01Z")),
    P("x2", "x3", R("t2", "ok", "2026-09-03T11:00:02Z")),
    P("x2", "x4", A("n2", { type: "text", text: "Passing." }, "2026-09-03T11:00:03Z")),
  ]);
  assert.deepEqual(blocks(g, { from: 0 }).blocks.map(b => `${b.seq}:${b.kind}`), ["0:user", "1:tool", "3:text", "3:turn"]);
});
