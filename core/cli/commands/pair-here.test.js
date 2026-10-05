// `vyre up` on an unpaired server shows the same pairing as the installer, in the same words: the QR, the long code and the typed code with its life and tries, the ack prompt when the app has typed the code,
// the closed-code and new-code lines, and the three-words pick. The daemon's tools are faked here; test/wink-typed-default.test.js and the box walk run the real ones.
import "../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { pairHere } from "./pair-here.js";
import { PAIR_WORDS as W, say as fill } from "../pair-words.js";

/** A scripted server: `status` answers in order, `confirm` is what the ack answers. */
function rig({ tty = true, code = "WINK-AB12-CD34", statuses = [], confirm = { ok: true }, asking = [{ asking: false }], answer = { yes: true } } = {}) {
  /** @type {string[]} */ const lines = []; /** @type {string[]} */ const asked = []; /** @type {any[]} */ const calls = [];
  let t = 1_000_000; const answers = [...asking];
  const tool = async (name, input = {}) => {
    calls.push([name, input]);
    if (name === "wink.server.code") return { data: { qr: "vyre://wink/2?t=abc&r=ws%3A%2F%2Fr&k=server", art: "QR", expires: t + 300_000, ...(code ? { code, code_expires: t + 600_000, code_tries: 3 } : {}) } };
    if (name === "wink.code.status") return { data: statuses.length ? statuses.shift() : { code, state: "offered", offer: "o1", expires: t + 600_000 } };
    if (name === "wink.server.confirm") return { data: confirm };
    if (name === "wink.server.pairing") return { data: answers.length > 1 ? answers.shift() : answers[0] };
    if (name === "wink.server.pair.answer") return { data: answer };
    return { error: { code: "no_such_tool", message: name } };
  };
  const io = { tty, ask: async (/** @type {string} */ q) => { asked.push(q); return io.replies.shift() ?? ""; }, replies: /** @type {string[]} */ ([]) };
  return { tool, io, lines, asked, calls, say: (/** @type {string} */ s) => lines.push(s), sleep: async () => { t += 2000; }, now: () => t, advance: (/** @type {number} */ ms) => { t += ms; } };
}

test("it shows the QR, the long code and the typed code with its life and its tries, in the installer's words", async () => {
  const r = rig({ tty: false });
  await pairHere({ tool: r.tool, io: r.io, say: r.say, sleep: r.sleep, now: r.now });
  const text = r.lines.join("\n");
  for (const s of [W.intro, W.introPaste, fill(W.longCode, { long: "vyre://wink/2?t=abc&r=ws%3A%2F%2Fr&k=server" }), W.longLife, fill(W.typed, { code: "WINK-AB12-CD34" }), fill(W.typedLife, { minutes: 10, tries: 3 })]) assert.ok(text.includes(s), s);
});

test("no typed code when the kill switch is set: only the QR and the long code", async () => {
  const r = rig({ tty: false, code: "" });
  await pairHere({ tool: r.tool, io: r.io, say: r.say, sleep: r.sleep, now: r.now });
  assert.ok(!r.lines.join("\n").includes("type this code"));
});

test("when the app has typed the code the prompt is \"Type the code your app shows:\", the typed answer goes to wink.server.confirm, and a match is said", async () => {
  const r = rig({ statuses: [{ code: "WINK-AB12-CD34", state: "found", offer: "o1", expires: 1_600_000 }], asking: [{ asking: true, name: "Alex", choices: ["a b c", "d e f", "g h i"] }] });
  r.io.replies.push("zebra horse 123", "2");
  const res = await pairHere({ tool: r.tool, io: r.io, say: r.say, sleep: r.sleep, now: r.now });
  assert.equal(r.asked[0], W.prompt);
  assert.deepEqual(r.calls.find(c => c[0] === "wink.server.confirm")[1], { offer: "o1", typed: "zebra horse 123" });
  const text = r.lines.join("\n");
  assert.ok(text.includes(W.typedFound) && text.includes(W.matched));
  assert.equal(r.asked[1], W.pickPrompt, "then the three-words pick");
  assert.equal(res.paired, true);
});

test("a wrong ack says the code is closed and shows the new one; a code that closed by itself says why and shows the new one", async () => {
  const r = rig({ confirm: { ok: false }, statuses: [{ code: "WINK-AB12-CD34", state: "found", offer: "o1", expires: 1_600_000 }, { code: "WINK-ZZ99-YY88", state: "offered", offer: "o2", expires: 1_600_000 }], asking: [{ asking: false }] });
  r.io.replies.push("nope");
  const p = pairHere({ tool: r.tool, io: r.io, say: r.say, sleep: r.sleep, now: r.now });
  await p;
  const text = r.lines.join("\n");
  assert.ok(text.includes(W.wrong), "the wrong ack closes the code");
  assert.ok(text.includes(fill(W.newCode, { code: "WINK-ZZ99-YY88", minutes: 10 })), "and the new code is shown");
  const r2 = rig({ statuses: [{ code: "WINK-NEW1-NEW2", state: "offered", offer: "o9", expires: 1_600_000 }], asking: [{ asking: false }] });
  await pairHere({ tool: r2.tool, io: r2.io, say: r2.say, sleep: r2.sleep, now: r2.now });
  const t2 = r2.lines.join("\n");
  assert.ok(t2.includes(fill(W.closed, { tries: 3 })) && t2.includes(fill(W.newCode, { code: "WINK-NEW1-NEW2", minutes: 10 })));
});

test("an empty pick refuses and pairs nothing; the codes running out ends with the way back", async () => {
  const r = rig({ asking: [{ asking: true, name: "Mallory", choices: ["a b c", "d e f", "g h i"] }] });
  r.io.replies.push("");
  assert.deepEqual((await pairHere({ tool: r.tool, io: r.io, say: r.say, sleep: r.sleep, now: r.now })).paired, false);
  assert.ok(r.lines.includes(W.refused));
  const q = rig({}); const start = q.now();
  const sleepy = async () => { q.advance(120_000); };
  const res = await pairHere({ tool: q.tool, io: q.io, say: q.say, sleep: sleepy, now: q.now });
  assert.equal(res.why, "expired"); assert.ok(q.lines.includes(W.ranOut)); void start;
});
