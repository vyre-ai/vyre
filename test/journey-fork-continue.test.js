// @ts-check
// Fork and continue on the other place, on a real vyred (the fake claude, the owner's own session): the chat tools sheet's "Fork and continue on the server" is threads.fork and then runner.move of the copy,
// and the words it shows are made from the box's own answers (apps/app/screens/chat-tools/fork-move.js, the same function the sheet calls).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, terminalSession } from "../core/sessions/testing/boot.js";
import { forkAndMove } from "../apps/app/screens/chat-tools/fork-move.js";

/** The sheet's two calls, as the app makes them: the box answers or refuses. @param {any} w */
const box = (w) => ({
  fork: async (/** @type {string} */ thread) => { const r = await w.tool("threads.fork", { thread, surface: "deck" }); return r.error ? { ok: /** @type {const} */ (false), reason: r.error.message } : { ok: /** @type {const} */ (true), thread: String(r.data.id) }; },
  move: async (/** @type {string} */ thread, /** @type {"mac" | "server"} */ to) => { const r = await w.tool("runner.move", { thread, to }); if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r.data; },
});

test("a chat's copy goes to the server: the copy is a new chat, the chat is untouched, and the box says where it runs", async t => {
  const w = await boot(t, { driver: "cli", kernel: true });
  const chat = terminalSession(w.transcripts, w.work, { ageMs: 0 });
  const out = await forkAndMove(box(w), chat.id, "server");
  assert.equal(out.ok, true, JSON.stringify(out));
  if (!out.ok) return;
  assert.notEqual(out.thread, chat.id, "a copy, not the chat");
  assert.equal(out.note, "The copy runs on the server.");
  const threads = (await w.tool("threads.list", {})).data;
  const rows = Array.isArray(threads) ? threads : threads.threads;
  assert.ok(rows.some((/** @type {any} */ r) => r.id === out.thread), "the copy is in the list");
  assert.ok(rows.some((/** @type {any} */ r) => r.id === chat.id), "the chat is still there");
});

test("a copy that cannot go to this Mac is kept, and the sheet says why in the box's own words", async t => {
  const w = await boot(t, { driver: "cli", kernel: true });
  const chat = terminalSession(w.transcripts, w.work, { ageMs: 0 });
  const out = await forkAndMove(box(w), chat.id, "mac");
  assert.equal(out.ok, true, JSON.stringify(out));
  if (!out.ok) return;
  assert.match(out.note, /^The copy is made, but it could not go to this Mac: no computer of yours is set up to run this Space's chats yet/);
  assert.notEqual(out.thread, chat.id);
});

test("a chat that is not there is not forked", async t => {
  const w = await boot(t, { driver: "cli", kernel: true });
  const out = await forkAndMove(box(w), "no-such-chat", "server");
  assert.equal(out.ok, false);
});
