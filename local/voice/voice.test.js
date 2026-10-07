// @ts-check
// voice: push-to-talk through a real vyred and a real upgrade on its socket, against a fake
// speech provider on 127.0.0.1. No test reaches a real provider, holds a real key, or captures
// real audio: the Swift mic is only compiled here, and its conversion checked on a synthetic sine.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { start } from "../../core/daemon/index.js";
import { call } from "../../core/daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";
import { connect, encodeFrame, FrameParser } from "./ws.js";
import { origin, wav } from "./providers.js";
import { listener } from "./listen.js";
import { fakeSpeech, AUDIO, WORDS } from "./fake.js";

const HERE = import.meta.dirname;
const GOOD = "dg-test-key-northwind-0000";
const BAD = "dg-FAKE-SECRET-kit-9f8e7d6c5b4a";
const CHUNK = 3200; // 100 ms of 16 kHz linear16

/** A port nothing listens on: bound, read, and closed again. */
// Speech tests run the legacy direct path (the daemon here has no inference door); the door path is tested in lib/door-bridge.test.js.
process.env.VYRE_LEGACY_DIRECT_MODEL = "1";

async function closedPort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {any} */ (s.address()).port;
  await new Promise(r => s.close(() => r(undefined)));
  return port;
}

/** 100 ms of a quiet tone, as the Capsule would send it. */
const pcm = (i = 0) => { const b = Buffer.alloc(CHUNK); for (let k = 0; k < CHUNK / 2; k++) b.writeInt16LE(Math.round(8000 * Math.sin((i * 1600 + k) / 5)), k * 2); return b; };

/** Open the listen stream on vyred's socket as `caller`, and gather what comes back. */
async function listen(root, caller = "capsule") {
  const r = await connect("ws://vyred/v1/streams/voice/listen", { socketPath: path.join(root, "vyred.sock"), headers: { "x-vyre-caller": caller } });
  if (!r.peer) return { refused: r.status, body: r.body };
  const peer = r.peer;
  /** @type {any[]} */
  const got = [];
  let closeCode = 0;
  const waiters = [];
  peer.on("message", m => { got.push(JSON.parse(String(m.text))); for (const w of [...waiters]) w(); });
  const closed = new Promise(res => peer.on("close", code => { closeCode = code; res(code); for (const w of [...waiters]) w(); }));
  const until = (pred, what, ms = 5000) => new Promise((res, rej) => {
    const check = () => { const v = pred(); if (v) { clearTimeout(t); waiters.splice(waiters.indexOf(check), 1); res(v); } };
    const t = setTimeout(() => rej(new Error(`timed out waiting for ${what}; got ${JSON.stringify(got)}`)), ms);
    waiters.push(check); check();
  });
  return { peer, got, closed, until, get closeCode() { return closeCode; } };
}

/** GET a path on vyred's socket as `caller`, as raw bytes. */
function get(root, p, caller = "capsule") {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(root, "vyred.sock"), path: p, method: "GET", headers: { "x-vyre-caller": caller } }, res => {
      const c = []; res.on("data", d => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], body: Buffer.concat(c) }));
    });
    req.on("error", reject); req.end();
  });
}

test("voice: push-to-talk through a real vyred, every failure visible, and the key nowhere", async t => {
  const root = tempHome(t);
  const fake = await fakeSpeech({ key: GOOD });
  t.after(() => fake.close());
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-mac", transcripts: [], vault: { keystore: "file" },
    modules: { enable: ["voice"], disable: ["recall", "memory", "learn", "capsule", "hands", "screen"] },
    voice: { provider: "deepgram", endpoints: { deepgram: fake.base, openai: fake.base, elevenlabs: fake.base } } }));
  const lines = [];
  const d = await start({ root, presence: present, log: (m, x) => lines.push(m + (x ? " " + JSON.stringify(x) : "")) });
  t.after(() => d.stop());
  assert.equal(d.registry.status().find(m => m.name === "voice")?.state, "running", lines.join("\n"));
  const as = caller => (tool, input = {}) => call(tool, input, { root, caller });
  const cli = as("cli"), capsule = as("capsule");
  const voice = /** @type {any} */ (d.registry.modules.get("voice")).handle;
  const timers = () => process.getActiveResourcesInfo().filter(x => x === "Timeout").length;
  const idleTimers = timers();

  await t.test("no key: an immediate no_key, then a clean close", async () => {
    const st = (await capsule("voice.status")).data;
    assert.equal(st.key, false); assert.equal(st.key_state, "missing"); assert.equal(st.online, true);
    const s = await listen(root);
    assert.ok(s.peer);
    await s.closed;
    assert.deepEqual(s.got.map(m => m.type), ["error"]);
    assert.equal(s.got[0].code, "no_key");
    assert.match(s.got[0].message, /Deepgram key/);
    assert.equal(s.closeCode, 1000, "a proper close frame, not a dropped socket");
  });

  // What a person does in the Capsule's Settings: save the key, then let voice use it.
  const save = async value => {
    const put = await cli("vault.put", { name: "voice-deepgram-key", kind: "api-key", value, description: "Deepgram key for push-to-talk" });
    assert.ok(!put.error, JSON.stringify(put.error));
    const g = await cli("vault.grant", { name: "voice-deepgram-key", module: "voice" });
    assert.ok(!g.error, JSON.stringify(g.error));
  };
  await save(GOOD);

  await t.test("a full round trip: PCM in, partials and finals out, done with the transcript", async () => {
    const st = (await capsule("voice.status")).data;
    assert.equal(st.key, true); assert.equal(st.mode, "streaming"); assert.equal(st.endpoint, "test override");
    assert.ok(!JSON.stringify(st).includes(GOOD), "status says whether, never what");
    // Timed from key down: the upgrade, the key out of the vault and the provider's handshake
    // all happen while the person is already talking.
    const t0 = performance.now();
    const s = await listen(root);
    assert.ok(s.peer);
    s.peer.binary(pcm(0));
    await s.until(() => s.got.find(m => m.type === "partial"), "the first partial");
    const firstPartialMs = performance.now() - t0;
    // 2 s of speech in 100 ms frames, sent as fast as a held key would, then release.
    const t1 = performance.now();
    for (let i = 1; i < 20; i++) s.peer.binary(pcm(i));
    const sendMs = performance.now() - t1;
    s.peer.json({ type: "end" });
    const done = await s.until(() => s.got.find(m => m.type === "done"), "done");
    await s.closed;
    const types = s.got.map(m => m.type);
    assert.equal(types[0], "listening");
    assert.ok(types.includes("partial") && types.includes("final"), types.join(","));
    assert.equal(done.text, WORDS.join(" "), "four words, one per half second of audio");
    assert.equal(s.got.filter(m => m.type === "final").at(-1).text, done.text, "the last final is the whole utterance");
    assert.equal(fake.got.audioBytes, 20 * CHUNK, "every byte relayed, including the frame sent before the provider was open");
    assert.equal(fake.got.closeStream, 1, "release sends CloseStream");
    assert.equal(s.closeCode, 1000);
    t.diagnostic(`first partial ${firstPartialMs.toFixed(1)} ms after key down (upgrade + key from the vault + provider handshake + one relay, fake on loopback); 2 s of audio (${20 * CHUNK} bytes, 32 kB/s realtime) written in ${sendMs.toFixed(1)} ms`);
  });

  await t.test("a frame sent before the key is out of the vault is not lost", async () => {
    const before = fake.got.audioBytes;
    const s = await listen(root);
    assert.ok(s.peer);
    s.peer.binary(pcm(0)); s.peer.binary(pcm(1)); s.peer.json({ type: "end" });
    await s.until(() => s.got.find(m => m.type === "done"), "done");
    assert.equal(fake.got.audioBytes - before, 2 * CHUNK);
  });

  await t.test("a refused key: provider_rejected, and the key is nowhere the person or a log can see", async () => {
    await save(BAD);
    const s = await listen(root);
    assert.ok(s.peer);
    s.peer.binary(pcm(0));
    await s.closed;
    const err = s.got.find(m => m.type === "error");
    assert.equal(err.code, "provider_rejected");
    assert.match(err.message, /HTTP 401/);
    const spoke = await capsule("voice.settings", { speak: true });
    const said = await capsule("voice.speak", { text: "hello alex" });
    assert.equal(said.error.code, "provider_rejected");
    assert.equal((await capsule("voice.speak", { text: "x" })).error.code, "provider_rejected");
    assert.ok(!spoke.error);
    await capsule("voice.settings", { speak: false });
    // The fake quoted the key back in its 401; none of that may surface anywhere.
    const everything = [JSON.stringify(s.got), JSON.stringify(said), lines.join("\n"), JSON.stringify(d.events.since(0, { limit: 100000 })),
      fs.readFileSync(path.join(root, "config.json"), "utf8"),
      ...fs.readdirSync(path.join(root, "logs")).map(f => { try { return fs.readFileSync(path.join(root, "logs", f), "utf8"); } catch { return ""; } })].join("\n");
    assert.ok(!everything.includes(BAD), "the refused key appears in no frame, tool result, log line, event or file");
    assert.ok(!everything.includes(GOOD), "nor does the good one");
    await save(GOOD);
  });

  await t.test("offline: a provider that cannot be reached is offline, in the stream and in status", async () => {
    const port = await closedPort();
    d.config.voice.endpoints.deepgram = `http://127.0.0.1:${port}`;
    assert.equal((await capsule("voice.status")).data.online, false);
    const s = await listen(root);
    assert.ok(s.peer);
    await s.closed;
    assert.deepEqual(s.got.map(m => [m.type, m.code]), [["error", "offline"]]);
    d.config.voice.endpoints.deepgram = fake.base;
  });

  await t.test("an endpoint override off this machine is refused, http or https", async () => {
    for (const bad of ["http://example.com", "https://evil.example", "http://127.0.0.1.evil.example", "http://user:pw@127.0.0.1:1", "http://127.0.0.1:9/v1"]) {
      assert.throws(() => origin("deepgram", { deepgram: bad }), /must be http\(s\):\/\/127\.0\.0\.1/, bad);
      d.config.voice.endpoints.deepgram = bad;
      const s = await listen(root);
      await s.closed;
      assert.deepEqual(s.got.map(m => [m.type, m.code]), [["error", "bad_endpoint"]], bad);
      assert.match((await capsule("voice.status")).data.endpoint, /must be/);
    }
    assert.equal(origin("deepgram", {}), "https://api.deepgram.com");
    assert.equal(origin("deepgram", { deepgram: "https://127.0.0.1:8443" }), "https://127.0.0.1:8443");
    d.config.voice.endpoints.deepgram = fake.base;
    assert.equal(fake.got.auth.filter(Boolean).length, fake.got.auth.length, "every request that reached the fake carried a key, and nothing else was dialled");
  });

  await t.test("the stream is refused to anyone but this Mac's own callers", async () => {
    for (const caller of ["tailnet:juno", "mcp", "module:notes", "", "cli agent:kit", "local agent:kit", "deck agent:kit", "cli:thread:x", "LOCAL:Thread:x"]) {
      const s = await listen(root, caller);
      assert.equal(s.refused, 403, caller);
      assert.equal(JSON.parse(String(s.body)).error.code, "denied");
    }
    // "deck" is allowed (chat's push-to-talk, native-core, 28 Sep): the Deck served locally on
    // this same Mac, gated the same way as capsule/local/cli -- but only when it is not a peer
    // connection (checked just below), which is what actually keeps a remote Deck out.
    const asDeck = await listen(root, "deck");
    assert.ok(asDeck.peer, "deck is now a local caller: the upgrade succeeds, not a 403");
    asDeck.peer.close(1000);
    // A listener that forwards an upgrade with the peer it established is refused too, whatever
    // caller it names: the handler checks the peer, not just the label.
    const l = listener({ vault: { fetch: async () => GOOD }, config: d.config, log: () => {} });
    const written = [];
    const sock = /** @type {any} */ ({ write: b => written.push(String(b)), end: b => written.push(String(b)), on() {}, destroy() {} });
    l.handle({ headers: { upgrade: "websocket", "sec-websocket-key": "x" } }, sock, Buffer.alloc(0), { caller: "capsule", peer: { node: "juno", login: "alex" } });
    assert.match(written.join(""), /^HTTP\/1\.1 403/);
    assert.equal(l.open, 0);
    assert.equal((await as("mcp")("voice.speak", { text: "hi" })).error.code, "denied");
    assert.equal((await d.registry.call("voice.status", {}, "capsule", { peer: { node: "juno" } })).error.code, "denied");
  });

  await t.test("voice.listen: a ticket for a caller that cannot set x-vyre-caller itself (the Deck's browser WS)", async () => {
    const r = await as("deck")("voice.listen", {});
    assert.match(r.data.path, /^\/v1\/streams\/voice\/listen\?ticket=[A-Za-z0-9_-]{32}$/);
    // No x-vyre-caller at all, the way a real browser WebSocket connects: the ticket alone gets it in.
    const s = await connect(`ws://vyred${r.data.path}`, { socketPath: path.join(root, "vyred.sock") });
    assert.ok(s.peer, "the ticket is the whole authority");
    s.peer.close(1000);
    // Spent: the same path again is refused, whatever calls it.
    const again = await connect(`ws://vyred${r.data.path}`, { socketPath: path.join(root, "vyred.sock") });
    assert.equal(again.status, 403);
    // An agent never gets a ticket to hand out in the first place.
    assert.equal((await as("cli agent:kit")("voice.listen", {})).error.code, "denied");
    assert.equal((await as("cli:thread:x")("voice.listen", {})).error.code, "denied", "a thread claim is never the person at the mic");
    assert.equal((await d.registry.call("voice.listen", {}, "deck", { peer: { node: "juno" } })).error.code, "denied");
    // voice.status refuses an agent caller the same way (the lead, 28 Sep).
    assert.equal((await as("local agent:kit")("voice.status", {})).error.code, "denied");
    assert.equal((await as("local:thread:x")("voice.status", {})).error.code, "denied");
  });

  await t.test("voice.speak: off by default, then audio from the fake, once, to a local caller", async () => {
    assert.equal((await capsule("voice.speak", { text: "Northwind Bakery opens at nine" })).error.code, "speak_off");
    assert.deepEqual((await capsule("voice.settings", { speak: true, voice: "aura-2-thalia-en" })).data, { provider: "deepgram", speak: true, voice: "aura-2-thalia-en" });
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).voice.speak, true, "settings persist in config.json");
    assert.ok(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).voice.endpoints, "a settings change keeps the rest of voice's config");
    const r = (await capsule("voice.speak", { text: "Northwind Bakery opens at nine" })).data;
    assert.match(r.url, /^\/v1\/voice\/speech\?ticket=[A-Za-z0-9_-]{32}$/);
    assert.equal((await get(root, r.url, "mcp")).status, 404, "a ticket is for this Mac's own callers");
    const a = await get(root, r.url);
    assert.equal(a.status, 200); assert.equal(a.type, "audio/mpeg");
    assert.deepEqual(a.body, AUDIO);
    assert.equal((await get(root, r.url)).status, 404, "a ticket plays once");
    assert.deepEqual(fake.got.speak.at(-1), { provider: "deepgram", model: "aura-2-thalia-en", text: "Northwind Bakery opens at nine" });
    assert.equal((await capsule("voice.settings", { voice: "../../etc" })).error.code, "bad_input");
  });

  await t.test("voice.speak: with no inference door and no legacyDirect, nothing is sent to the speech provider", async () => {
    const before = fake.got.speak.length;
    delete process.env.VYRE_LEGACY_DIRECT_MODEL;
    try {
      assert.equal((await capsule("voice.speak", { text: "Northwind Bakery opens at nine" })).error.code, "no_door");
      assert.equal(fake.got.speak.length, before, "the provider saw nothing");
    } finally { process.env.VYRE_LEGACY_DIRECT_MODEL = "1"; }
  });

  await t.test("openai and elevenlabs: held until release, transcribed in one request, and they speak", async () => {
    for (const [provider, item] of [["openai", "voice-openai-key"], ["elevenlabs", "voice-elevenlabs-key"]]) {
      await capsule("voice.settings", { provider, voice: "" });
      const s0 = await listen(root);
      await s0.closed;
      assert.equal(s0.got[0].code, "no_key", provider);
      await cli("vault.put", { name: item, kind: "api-key", value: GOOD });
      await cli("vault.grant", { name: item, module: "voice" });
      const st = (await capsule("voice.status")).data;
      assert.equal(st.mode, "on-release"); assert.equal(st.key, true);
      const s = await listen(root);
      for (let i = 0; i < 10; i++) s.peer.binary(pcm(i));
      s.peer.json({ type: "end" });
      const done = await s.until(() => s.got.find(m => m.type === "done"), `${provider} done`);
      assert.deepEqual(s.got.map(m => m.type), ["listening", "final", "done"]);
      assert.equal(s.got[0].streaming, false);
      assert.equal(done.text, "hello from", "one second of audio");
      assert.deepEqual(fake.got.transcribe.at(-1), { provider, pcm: 10 * CHUNK, wav: true });
      const r = (await capsule("voice.speak", { text: "kit is ready" })).data;
      assert.deepEqual((await get(root, r.url)).body, AUDIO);
      assert.equal(fake.got.speak.at(-1).provider, provider);
    }
    await capsule("voice.settings", { provider: "deepgram", speak: false });
  });

  await t.test("idle: no stream, no ticket, and no timer left behind", async () => {
    const r = (await capsule("voice.settings", { speak: true })) && (await capsule("voice.speak", { text: "juno" })).data;
    assert.equal(voice.idle().tickets, 1);
    await get(root, r.url);
    await capsule("voice.settings", { speak: false });
    await new Promise(res => setTimeout(res, 1200)); // a closed socket's 1 s destroy guard
    assert.deepEqual(voice.idle(), { streams: 0, tickets: 0 });
    assert.ok(timers() <= idleTimers, `timers at idle: ${timers()} now, ${idleTimers} before any stream`);
  });
});

test("ws: frames both ways, masked from the client and not from the server, fragments joined", () => {
  const server = new FrameParser({ masked: true }), client = new FrameParser({ masked: false });
  const big = Buffer.alloc(70_000, 7);
  assert.deepEqual(server.push(Buffer.concat([encodeFrame(Buffer.from("{\"type\":\"end\"}"), 1, true), encodeFrame(big, 2, true)])), [{ text: "{\"type\":\"end\"}" }, { binary: big }]);
  assert.deepEqual(client.push(encodeFrame(Buffer.from("hi"), 1)), [{ text: "hi" }]);
  assert.throws(() => server.push(encodeFrame(Buffer.from("x"), 2)), /must be masked/);
  assert.throws(() => new FrameParser({ masked: false }).push(encodeFrame(Buffer.from("x"), 2, true)), /must not be masked/);
  const a = encodeFrame(Buffer.from("hel"), 1, true); a[0] &= 0x7f;
  const b = encodeFrame(Buffer.from("lo"), 0, true);
  const p = new FrameParser({ masked: true });
  assert.deepEqual(p.push(a), []);
  assert.deepEqual(p.push(b.subarray(0, 3)), []);
  assert.deepEqual(p.push(b.subarray(3)), [{ text: "hello" }]);
  const w = wav(Buffer.alloc(3200));
  assert.equal(w.length, 3244); assert.equal(w.toString("latin1", 0, 4), "RIFF"); assert.equal(w.readUInt32LE(24), 16000);
});

test("vyre-mic: builds with swiftc, and its conversion turns a 48 kHz float sine into 16 kHz Int16", async t => {
  if (process.platform !== "darwin") return t.skip("vyre-mic is macOS only");
  try { execFileSync("which", ["swiftc"], { stdio: "ignore" }); } catch { return t.skip("swiftc is not installed"); }
  execFileSync("sh", [path.join(HERE, "build.sh")], { stdio: "pipe", timeout: 300_000 });
  const bin = path.join(HERE, "bin", "vyre-mic");
  // Never capture: --selftest synthesises its input, and dialogs are off under node --test.
  const r = JSON.parse(execFileSync(bin, ["--selftest", "5"], { encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: "1" } }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(Math.abs(r.samples - 80_000) <= 800, `samples ${r.samples}`);
  assert.ok(r.peak >= 0.45 * 32767 && r.peak <= 0.55 * 32767, `peak ${r.peak}`);
  const st = JSON.parse(execFileSync(bin, ["--status"], { encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: "1" } }));
  assert.equal(st.dialogs, false, "no permission dialog can be raised from a test");
  t.diagnostic(`selftest: ${r.samples} samples, peak ${r.peak}, ${r.convert_ms} ms to convert 5 s (${r.realtime_x}x realtime)`);
});
