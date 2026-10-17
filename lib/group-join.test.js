// @ts-check
// Adding someone to a chat: a chat that runs on a computer moves to the server first, once, with the joiner's name; nothing is added when it cannot move; a chat the person is not in or nobody new changes nothing here.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { moveBeforeJoin } from "./group-join.js";

const chain = { hops: [{ actor: { kind: "person", id: "per_a" } }] };
const kernel = (/** @type {string[] | null} */ people) => ({ chats: { read: () => { if (!people) throw new Error("no such chat"); return { people }; } } });   // synchronous, as the kernel's is
const roster = { data: { members: [{ person: "per_b", name: "Dana" }, { person: "per_c", name: "Theo" }] } };

function rig(/** @type {any} */ move = { data: { moved: true } }) {
  /** @type {any[]} */ const calls = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input) => { calls.push([tool, input]); if (tool === "spaces.members.list") return roster; if (move instanceof Error) throw move; return move; };
  return { calls, call };
}

test("someone new joins: the chat moves once, naming them, and only then may they be added", async () => {
  const r = rig();
  const out = await moveBeforeJoin({ kernel: kernel(["per_a"]), chain, call: r.call, chat: "chat_x", add: ["per_b", "per_c", "per_a"] });
  assert.deepEqual(out, { moved: true });
  const moves = r.calls.filter(c => c[0] === "runner.group-move");
  assert.equal(moves.length, 1);
  assert.deepEqual(moves[0][1], { chat: "chat_x", person: "per_a", names: ["Dana", "Theo"] });
});

test("nobody new, nothing to add, or a chat the person is not in: no move, no TypeError", async () => {
  for (const [k, add] of /** @type {[any, any][]} */ ([[kernel(["per_a", "per_b"]), ["per_b"]], [kernel(["per_a"]), []], [kernel(["per_a"]), undefined], [kernel(null), ["per_b"]]])) {
    const r = rig();
    assert.deepEqual(await moveBeforeJoin({ kernel: k, chain, call: r.call, chat: "chat_x", add }), { moved: false });
    assert.equal(r.calls.filter(c => c[0] === "runner.group-move").length, 0);
  }
});

test("when the chat cannot move, the refusal is the box's own words and nobody is added", async () => {
  const r = rig({ error: { code: "conflict", message: "This chat works in a folder on your computer, so it stays there. Start a new chat to talk with others." } });
  await assert.rejects(moveBeforeJoin({ kernel: kernel(["per_a"]), chain, call: r.call, chat: "chat_x", add: ["per_b"] }), (/** @type {any} */ e) => e.code === "conflict" && /folder on your computer/.test(e.message));
  const t = rig(Object.assign(new Error("boom"), { code: "unavailable" }));
  await assert.rejects(moveBeforeJoin({ kernel: kernel(["per_a"]), chain, call: t.call, chat: "chat_x", add: ["per_b"] }), (/** @type {any} */ e) => e.code === "unavailable");
});

test("a box without the runner adds people as it always did; a roster that names no one says someone", async () => {
  const r = rig({ error: { code: "no_such_tool", message: "no such tool" } });
  assert.deepEqual(await moveBeforeJoin({ kernel: kernel(["per_a"]), chain, call: r.call, chat: "chat_x", add: ["per_b"] }), { moved: false });
  const u = rig();
  const bare = async (/** @type {string} */ tool, /** @type {any} */ input) => (tool === "spaces.members.list" ? null : u.call(tool, input));
  await moveBeforeJoin({ kernel: kernel(["per_a"]), chain, call: bare, chat: "chat_x", add: ["per_z"] });
  assert.deepEqual(u.calls.find(c => c[0] === "runner.group-move")?.[1].names, ["someone"]);
});
