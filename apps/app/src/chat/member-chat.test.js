import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { connect } from "../../../../core/stream/client.js";
import { frame } from "../../../../core/stream/protocol.js";
import { pollDuplex } from "./member-poll.js";

/** A member's team chat through the REAL resumable client and the poller: another person's message, then the AI's answer in two text pieces. */
const log = (/** @type {string} */ session) => [
  { ...frame("user-message", { message: "m1", text: "Ana: can you draft the intake letter?", state: "sent" }, { session }), cur: 1, author: "person:per_ana" },
  { ...frame("text-delta", { message: "a1", text: "Here is a first" }, { session }), cur: 2, author: "assistant:assistant" },
  { ...frame("text-delta", { message: "a1", text: " draft of the letter." }, { session }), cur: 3, author: "assistant:assistant" },
];

test("a member's team chat screen gets another person's message and the AI's answer, in order, once each, through the client the chat screen uses", async () => {
  const frames = log("chat_1");
  const calls = /** @type {any[]} */ ([]);
  const call = async (/** @type {string} */ _n, /** @type {any[]} */ args) => {
    const a = args[0]; calls.push(a);
    const got = frames.filter((f) => f.cur > a.from).slice(0, a.limit);
    return { viewer: "person:per_me", head: frames.length, floor: 1, frames: got, next: got.length ? got[got.length - 1].cur : a.from };
  };
  const seen = /** @type {any[]} */ ([]);
  const states = /** @type {string[]} */ ([]);
  const h = connect({ from: 0, open: () => pollDuplex({ call, chat: "chat_1", from: 0, sleep: () => new Promise((r) => setTimeout(r, 5)) }), onFrame: (f) => seen.push(f), onState: (s) => states.push(s) });
  for (let i = 0; i < 30 && seen.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
  h.close();
  assert.deepEqual(seen.map((f) => [f.cur, f.type, f.author]), [[1, "chat.user-message", "person:per_ana"], [2, "chat.text-delta", "assistant:assistant"], [3, "chat.text-delta", "assistant:assistant"]]);
  assert.equal(seen[0].data.text, "Ana: can you draft the intake letter?");
  assert.equal(seen.slice(1).map((f) => f.data.text).join(""), "Here is a first draft of the letter.");
  assert.ok(states.includes("live"), "the client says live");
  assert.ok(calls.slice(1).every((c) => c.from >= 0 && c.chat === "chat_1"), "it only asks for this chat");
});

test("the chat stream's own-home paths are untouched: the team branch comes first and only for a joined team's chat; writes of a team chat go through the door", () => {
  const src = fs.readFileSync(new URL("./box-stream.ts", import.meta.url), "utf8");
  const at = (/** @type {string} */ s) => { const i = src.indexOf(s); assert.ok(i >= 0, `missing: ${s}`); return i; };
  assert.ok(at("const team = await teamSpace();") < at("if (peerWanted())"), "the team branch is first");
  assert.ok(at("if (peerWanted())") < at('call<{ path: string; viewer?: string; head?: number; session?: string }>("stream.open"'), "her own home over the relay, then the ticketed socket: as before");
  assert.match(src, /peerDuplex\(session, from(, [^)]*)?\)/);
  assert.match(src, /await tool\("work\.chat\.get", \{ chat: session \}\)/, "a chat is the team's only when the team's door knows it");
  assert.match(src, /if \(!\(await teamSpace\(\)\)\) return write\(name, input\);/, "not a team chat: the outbox as before");
  assert.equal((src.match(/await write\(/g) || []).length, 0, "no write goes around writeVia");
});
