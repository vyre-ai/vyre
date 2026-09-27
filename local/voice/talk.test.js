// @ts-check
// talk: the terminal push-to-talk against a real vyred, a fake mic and the fake speech provider,
// plus `vyre voice key` and `vyre voice status` run as a person would, as a real process.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { start } from "../../core/daemon/index.js";
import { call } from "../../core/daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";
import { fakeSpeech, WORDS } from "./fake.js";
import { talkLoop, utterance } from "./talk.js";

const HERE = import.meta.dirname;
const VYRE = path.join(HERE, "..", "..", "bin", "vyre");
const GOOD = "dg-test-key-northwind-0000";
const MIC = { bin: process.execPath, args: [path.join(HERE, "fake-mic.js")] };
const until = async (pred, what, ms = 5000) => {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 10)); }
};

/** Run bin/vyre against the temp home, with stdin piped. */
function vyre(root, args, stdin = "") {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [VYRE, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", d => { out += d; });
    p.stderr.on("data", d => { out += d; });
    p.on("close", code => resolve({ code, out }));
    p.stdin.end(stdin);
  });
}

test("talk: the terminal path end to end, with the key saved through the CLI and never shown", async t => {
  const root = tempHome(t);
  const fake = await fakeSpeech({ key: GOOD });
  t.after(() => fake.close());
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-mac", transcripts: [], vault: { keystore: "file" },
    modules: { enable: ["voice"], disable: ["recall", "memory", "learn", "capsule", "hands", "screen"] },
    voice: { provider: "deepgram", endpoints: { deepgram: fake.base } } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const socketPath = path.join(root, "vyred.sock");

  await t.test("status before a key says how to save one", async () => {
    const r = await vyre(root, ["voice", "status"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /deepgram/); assert.match(r.out, /missing/); assert.match(r.out, /vyre voice key deepgram/);
  });

  await t.test("utterance without a key: the provider's words never, a no_key error", async () => {
    const u = await utterance({ socketPath, mic: MIC });
    const last = await u.done;
    assert.equal(last.type, "error"); assert.equal(last.code, "no_key");
  });

  await t.test("vyre voice key: piped in, stored, granted to voice, and never echoed", async () => {
    const r = await vyre(root, ["voice", "key"], GOOD + "\n");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /stored/); assert.match(r.out, /granted to voice/);
    assert.equal(r.out.includes(GOOD), false, "the key was echoed");
    const st = (await call("voice.status", {}, { root, caller: "cli" })).data;
    assert.equal(st.key, true);
    const empty = await vyre(root, ["voice", "key"], "");
    assert.equal(empty.code, 1); assert.match(empty.out, /nothing stored/);
    const bad = await vyre(root, ["voice", "key", "whisper"], "x\n");
    assert.equal(bad.code, 2, "a usage error exits 2 (EXIT.USAGE)"); assert.match(bad.out, /usage/);
  });

  await t.test("utterance: mic PCM streamed, partials heard, done with the words after stop", async () => {
    const heard = [];
    const u = await utterance({ socketPath, mic: MIC, onHeard: m => heard.push(m) });
    await until(() => heard.some(m => m.type === "partial"), "a partial");
    await until(() => fake.got.audioBytes >= 64_000, "two seconds of audio");
    u.stop();
    const last = await u.done;
    assert.equal(last.type, "done", JSON.stringify(last));
    assert.ok(last.text && WORDS.join(" ").startsWith(last.text.split(" ").slice(0, 4).join(" ")), last.text);
    assert.equal(heard[0].type, "listening");
  });

  await t.test("talkLoop: Enter talks, Enter stops, the final line stays, end of input quits", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", d => { text += d; });
    const sent = [];
    const loop = talkLoop({ socketPath, mic: MIC, input, output, onFinal: s => { sent.push(s); } });
    input.write("\n");
    await until(() => /hello/.test(text), "words on screen");
    input.write("\n");
    await until(() => sent.length === 1, "the final words");
    input.end();
    assert.equal(await loop, 0, text);
    assert.match(text, /Enter to talk/);
    assert.ok(sent[0].startsWith("hello"), sent[0]);
    assert.ok(text.split("\n").some(l => l.trim() === sent[0]), "the finished words are their own line");
  });

  await t.test("talkLoop: a mic without the grant is said plainly and exits 1", async () => {
    const input = new PassThrough(), output = new PassThrough();
    let text = "";
    output.on("data", d => { text += d; });
    const loop = talkLoop({ socketPath, mic: { ...MIC, env: { ...process.env, FAKE_MIC_FAIL: "not_granted" } }, input, output });
    input.write("\n");
    await until(() => /not_granted/.test(text), "the grant error");
    input.end();
    assert.equal(await loop, 1);
    assert.match(text, /microphone access is not granted/);
  });

  await t.test("talkLoop: an unbuilt vyre-mic says how to build it", async () => {
    const output = new PassThrough();
    let text = "";
    output.on("data", d => { text += d; });
    assert.equal(await talkLoop({ socketPath, mic: { bin: path.join(HERE, "no-such-mic") }, input: new PassThrough(), output }), 1);
    assert.match(text, /build\.sh/);
  });

  // The server side of a stream closes when its socket's close reaches vyred, a moment after the
  // client's: on a slow runner that is later than the last line above.
  const voice = /** @type {any} */ (d.registry.modules.get("voice")).handle;
  await until(() => voice.idle().streams === 0, "no stream left open");
  assert.equal(voice.idle().streams, 0, "no stream left open");
});
