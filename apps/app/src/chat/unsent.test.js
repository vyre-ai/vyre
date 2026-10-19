// @ts-check
// A message the box did not take never vanishes: it stays in the thread as "Not sent" with its reason, Retry sends the same words with the same message id, and only Delete (or the box's own
// echo of that message) takes it away. The one optimistic send of every chat screen (store.ts) is this.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createFolder } from "./frames.js";
import { createUnsent, NOT_SENT } from "./unsent.js";
import { reason } from "./reason.js";
import { callAgainOnce, retriesOnce } from "../real/peer-retry.js";

let cur = 0;
/** @param {string} type @param {any} data */
const fr = (type, data) => ({ v: 1, id: "x" + cur, cur: ++cur, session: "s", turn: "t", type: "session." + type, time: 0, corr: "t", data });
const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * The send as box-stream.ts makes it over the peer wire: stream.send on a stream, one more try on a fresh stream after a timeout (peer.ts), and the refusal in a person's words (reason.js).
 * `answers` is what each stream.send call does, in order.
 * @param {Array<"timeout" | "ok" | "refused">} answers
 */
function rig(answers) {
  cur = 0;
  const folder = createFolder();
  /** @type {{ text: string, message: string }[]} */ const sent = [];
  /** @type {any[]} */ let kept = [];
  let changes = 0;
  const streamSend = async (/** @type {{ text: string, message: string }} */ input) => {
    sent.push(input);
    const a = answers.shift() ?? "ok";
    if (a === "timeout") throw fail("timeout", "no answer to stream.send");
    if (a === "refused") throw fail("bad_input", "text is too long");
    return { message: input.message };
  };
  const perform = async (/** @type {import("./unsent.js").SendSpec} */ s) => {
    const call = () => streamSend({ text: s.text, message: s.message });
    try {
      try { await call(); } catch (e) { if (!retriesOnce(e)) throw e; await callAgainOnce({ stuck: "s1", drop: () => {}, reopen: async () => "s2", call }); }
      return null;
    } catch (e) { return reason(/** @type {any} */ (e)); }
  };
  const u = createUnsent({ folder, perform, changed: () => { changes++; }, saved: (l) => { kept = l; } });
  return { folder, u, sent, kept: () => kept, changes: () => changes };
}
const userRows = (/** @type {ReturnType<typeof createFolder>} */ f) => f.rows.filter((r) => r.kind === "user").map((r) => ({ key: r.key, ...f.item(r.key) }));

test("a send whose stream.send gets no answer (twice) stays in the thread as Not sent, with the reason in plain words; nothing removes the words", async () => {
  const r = rig(["timeout", "timeout"]);
  const why = await r.u.send({ via: "send", text: "Chase the invoices", message: "m-1" });
  assert.equal(r.sent.length, 2, "made once, then once more on a fresh stream");
  assert.ok(why && /did not answer in time/.test(why), why ?? "");
  assert.doesNotMatch(String(why), /stream\.send/, "no tool name in what the person reads");
  const rows = userRows(r.folder);
  assert.equal(rows.length, 1, "the words are still in the thread");
  assert.equal(rows[0].text, "Chase the invoices");
  assert.equal(rows[0].pending, false, "no longer Sending");
  assert.equal(rows[0].failed, why, "Not sent, and why");
  assert.deepEqual(r.kept().map((k) => k.spec.message), ["m-1"], "kept with the chat's cache, so it is still there when the chat opens again");
});

test("Retry sends the same words with the same message id and succeeds; the box's echo then takes the row's place", async () => {
  const r = rig(["timeout", "timeout", "ok"]);
  await r.u.send({ via: "send", text: "Chase the invoices", message: "m-1", o: { mode: "steer" } });
  const key = userRows(r.folder)[0].key;
  const again = await r.u.retry(key);
  assert.equal(again, null, "the retry went through");
  assert.deepEqual(r.sent.map((s) => s.message), ["m-1", "m-1", "m-1"], "the same message id every time, so the box says it once");
  assert.deepEqual(r.sent.map((s) => s.text), ["Chase the invoices", "Chase the invoices", "Chase the invoices"]);
  assert.equal(r.folder.item(key)?.pending, true, "Sending again until the box's own row arrives");
  assert.equal(r.folder.item(key)?.failed, undefined);
  assert.deepEqual(r.kept(), [], "nothing left that was not sent");
  r.folder.apply(fr("user-message", { message: "m-1", text: "Chase the invoices", state: "picked-up" }));
  r.u.settle();
  assert.deepEqual(userRows(r.folder).map((x) => x.key), ["u:m-1"], "one row, the box's");
});

test("a retry that fails again stays Not sent with the new reason; Delete is the only thing that takes the words away", async () => {
  const r = rig(["refused", "refused"]);
  const why = await r.u.send({ via: "sendTo", text: "x".repeat(10), message: "m-2", o: { to: ["assistant:juno"], fanout: false } });
  assert.equal(why, "text is too long");
  const key = userRows(r.folder)[0].key;
  assert.equal(await r.u.retry(key), "text is too long");
  assert.equal(r.folder.item(key)?.failed, "text is too long");
  assert.equal(await r.u.retry("o:999"), null, "an unknown row is no send");
  assert.equal(r.u.discard(key), true);
  assert.deepEqual(userRows(r.folder), []);
  assert.deepEqual(r.kept(), []);
  assert.equal(r.u.discard(key), false);
});

test("the box took a Not sent message after all (its echo arrives late): the row settles, and the cache forgets it", async () => {
  const r = rig(["timeout", "timeout"]);
  await r.u.send({ via: "send", text: "late", message: "m-3" });
  assert.equal(r.kept().length, 1);
  r.folder.apply(fr("user-message", { message: "m-3", text: "late", state: "sent" }));
  r.u.settle();
  assert.deepEqual(userRows(r.folder).map((x) => x.key), ["u:m-3"]);
  assert.deepEqual(r.kept(), []);
});

test("a send that throws without words, a reset of the stream, and opening the chat again: the words stay", async () => {
  cur = 0;
  const folder = createFolder();
  /** @type {any[]} */ let kept = [];
  const u = createUnsent({ folder, perform: async () => { throw new Error(""); }, changed: () => {}, saved: (l) => { kept = l; } });
  assert.equal(await u.send({ via: "send", text: "hello", message: "m-4" }), NOT_SENT);
  folder.apply(fr("reset", { head: 0 }));
  assert.equal(folder.item(userRows(folder)[0].key)?.failed, NOT_SENT, "a reset of the stream does not clear the person's own words");
  // the chat is left and opened again: a new folder, the cache's list put back
  cur = 0;
  const next = createFolder();
  const u2 = createUnsent({ folder: next, perform: async () => null, changed: () => {} });
  u2.restore(kept);
  u2.restore(kept);
  const rows = userRows(next);
  assert.equal(rows.length, 1, "put back once");
  assert.equal(rows[0].text, "hello");
  assert.equal(rows[0].failed, NOT_SENT);
  assert.equal(await u2.retry(rows[0].key), null);
  u2.restore([{ spec: { via: "nope", text: "x", message: "m" } }, { spec: { via: "send", text: " ", message: "m" } }, null]);
  assert.equal(userRows(next).length, 1, "a broken cache entry is skipped");
});

test("store.ts sends through the one optimistic send and never drops a refused message; the row shows Not sent, Retry and Delete", () => {
  const store = fs.readFileSync(new URL("./store.ts", import.meta.url), "utf8");
  assert.match(store, /createUnsent\(/);
  assert.match(store, /unsent\.send\(\{ via: "send"/);
  assert.match(store, /unsent\.send\(\{ via: "sendTo"/);
  assert.doesNotMatch(store, /dropOptimistic/, "the store never takes a refused message back out");
  assert.doesNotMatch(store, /withOptimistic/);
  const rows = fs.readFileSync(new URL("./ChatRows.tsx", import.meta.url), "utf8");
  assert.match(rows, /it\.failed \? <NotSent/);
  assert.match(rows, />Not sent</);
  assert.match(rows, /label=\{busy \? "Sending" : "Retry"\}/);
  assert.match(rows, /label="Delete"/);
});
