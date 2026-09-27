// @ts-check
// Every `vyre relay` verb as a person runs it: the real bin/vyre in a child process, against a
// vyred started in this process in a temp home, with the Node relay on 127.0.0.1. The person is
// stood in for by a presence verifier that finds one at every call (test/helpers.js present), so
// the changes go through; one test keeps the real verifier to show a change is refused without a
// person. A browser from the web app, played by the test, pairs through the QR code's address.
// No Tailscale, no Cloudflare, no dialogs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { tempHome, present } from "../../../test/helpers.js";
import { createRelay } from "../../../relay/node/server.js";
import { keyPair } from "../../relay/noise.js";
import { deviceSide } from "../../relay/channel.js";
import { parsePairUrl } from "../../relay/pairing.js";
import { useReleasesFile } from "../../relay/releases.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");

/** @returns {Promise<{ code: number, out: string, stdout: string }>} */
const run = (root, args) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" }, timeout: 30_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout + stderr, stdout })));

async function world(t, { presence = /** @type {any} */ (present) } = {}) {
  const relay = createRelay();
  const url = await relay.listen();
  t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [],
    network: { name: "alex" }, relay: { enabled: false, url }, modules: { disable: ["names", "onboard", "recall", "memory", "learn"] } }));
  const list = path.join(root, "releases.json");
  fs.writeFileSync(list, JSON.stringify({ releases: [{ release: "0.4.2", sha: "a".repeat(40), manifest: "a".repeat(64) }] }));
  useReleasesFile(list);
  t.after(() => useReleasesFile());
  const d = await start({ root, log: () => {}, ...(presence ? { presence } : {}) });
  t.after(() => d.stop());
  return { root, url };
}

/** A browser from the hosted web app that opens the pairing address, as Northwind Bakery's laptop. */
async function browser(t, scanned) {
  const offer = /** @type {any} */ (parsePairUrl(scanned));
  assert.ok(offer, "the pairing address parses");
  const ws = new WebSocket(`${offer.relay}/v1/device?route=${offer.route}`);
  ws.binaryType = "arraybuffer";
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  t.after(() => ws.close());
  const side = deviceSide({ send: b => ws.send(b), close: (c, r) => ws.close(c === 1000 || (c >= 3000 && c < 5000) ? c : 4000, r) },
    { s: keyPair(), box: offer.box, route: offer.route,
      hello: { v: 1, name: "Northwind laptop", kind: "web", release: "0.4.2", manifest: "a".repeat(64), pair: offer.secret } });
  ws.onmessage = e => { if (typeof e.data !== "string") side.receive(Buffer.from(e.data)); };
  ws.onclose = e => side.gone(e.reason || "closed");
  return (await side.ready).reply;
}

test("relay cli verbs: status, on, pair, devices, trust, rename, pin, unpin, remove, off", async t => {
  const { root, url } = await world(t);

  const s0 = await run(root, ["relay", "status", "--json"]);
  assert.equal(s0.code, 0, s0.out);
  const st = JSON.parse(s0.stdout);
  assert.equal(st.enabled, false);
  assert.equal(st.devices, 0);
  assert.equal(st.url, url);

  // on: a relay address that is not ws:// is the tool's refusal, and the CLI says so.
  const badUrl = await run(root, ["relay", "on", "--url", "http://127.0.0.1:9"]);
  assert.equal(badUrl.code, 1, badUrl.out);
  assert.match(badUrl.out, /ws:\/\/ or wss:\/\//);
  const on = await run(root, ["relay", "on", "--url", url]);
  assert.equal(on.code, 0, on.out);
  assert.match(on.out, new RegExp(`relay on · ${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const onJson = await run(root, ["relay", "on", "--json"]);
  assert.deepEqual(JSON.parse(onJson.stdout), { enabled: true, url });
  const s1 = await run(root, ["relay", "status"]);
  assert.equal(s1.code, 0, s1.out);
  assert.match(s1.out, /relay (connected|on, not connected yet)/);
  assert.match(s1.out, /0 devices paired/);

  // pair: the address the QR code holds; a browser from the web app opens it.
  const pair = await run(root, ["relay", "pair", "--json"]);
  assert.equal(pair.code, 0, pair.out);
  const reply = await browser(t, JSON.parse(pair.stdout).url);
  assert.equal(reply.paired, true);
  const id = reply.device;

  const list = await run(root, ["relay", "devices", "--json"]);
  assert.equal(list.code, 0, list.out);
  const devs = JSON.parse(list.stdout).devices;
  assert.deepEqual(devs.map(d => [d.id, d.name, d.kind, d.trusted]), [[id, "Northwind laptop", "web", false]]);
  const text = await run(root, ["relay", "devices"]);
  assert.match(text.out, /Northwind laptop/);
  assert.match(text.out, /web app, 0\.4\.2/);

  // trust and take it back.
  const trust = await run(root, ["relay", "trust", id]);
  assert.equal(trust.code, 0, trust.out);
  assert.match(trust.out, /has the full powers of your app/);
  assert.equal(JSON.parse((await run(root, ["relay", "devices", "--json"])).stdout).devices[0].trusted, true);
  const off = await run(root, ["relay", "trust", id, "--off", "--json"]);
  assert.equal(off.code, 0, off.out);
  assert.deepEqual(JSON.parse(off.stdout), { id, trusted: false });
  const noDevice = await run(root, ["relay", "trust", "aaaaaaaaaaaaaaaa"]);
  assert.equal(noDevice.code, 1, noDevice.out);
  assert.match(noDevice.out, /no paired device/);

  // rename: both words make the name; a missing name is a usage mistake with the next step.
  const noName = await run(root, ["relay", "rename", id]);
  assert.equal(noName.code, 2, noName.out);
  assert.match(noName.out, /vyre relay rename <id> <name>/);
  const renamed = await run(root, ["relay", "rename", id, "Harlow", "Legal", "laptop"]);
  assert.equal(renamed.code, 0, renamed.out);
  assert.match(renamed.out, new RegExp(`${id} is now Harlow Legal laptop`));

  // pin a release this box knows, refuse one it does not, then unpin.
  const pin = await run(root, ["relay", "pin", "0.4.2"]);
  assert.equal(pin.code, 0, pin.out);
  assert.match(pin.out, /pinned to 0\.4\.2/);
  const unknown = await run(root, ["relay", "pin", "9.9.9"]);
  assert.equal(unknown.code, 1, unknown.out);
  assert.match(unknown.out, /does not know web app release 9\.9\.9/);
  assert.equal((await run(root, ["relay", "pin"])).code, 2, "pin needs a release");
  const unpin = await run(root, ["relay", "unpin", "--json"]);
  assert.equal(unpin.code, 0, unpin.out);
  assert.deepEqual(JSON.parse(unpin.stdout), { pinned: null });

  // remove, then the list is empty.
  const removed = await run(root, ["relay", "remove", id]);
  assert.equal(removed.code, 0, removed.out);
  assert.match(removed.out, new RegExp(`removed ${id}`));
  assert.deepEqual(JSON.parse((await run(root, ["relay", "devices", "--json"])).stdout), { devices: [] });

  const down = await run(root, ["relay", "off"]);
  assert.equal(down.code, 0, down.out);
  assert.match(down.out, /relay off; paired devices stay paired/);
  assert.equal(JSON.parse((await run(root, ["relay", "status", "--json"])).stdout).enabled, false);
});

test("relay cli verbs: with the real verifier and no terminal, a change is refused with exit 3", async t => {
  // On a Mac a terminal could offer Touch ID, which a test must never raise: Linux only.
  if (process.platform !== "linux") return t.skip("the refusal is checked on Linux, where the child has no terminal");
  const { root } = await world(t, { presence: null });
  for (const args of [["relay", "on"], ["relay", "off"], ["relay", "unpin"]]) {
    const r = await run(root, args);
    assert.equal(r.code, 3, `${args.join(" ")}: ${r.out}`);
    assert.match(r.out, /terminal/);
    assert.match(r.out, /next: run it in your own terminal/);
  }
  const j = await run(root, ["relay", "off", "--json"]);
  assert.equal(j.code, 3);
  assert.equal(JSON.parse(j.stdout).error.code, "no_terminal");
  assert.equal(JSON.parse((await run(root, ["relay", "status", "--json"])).stdout).enabled, false, "nothing changed");
});

test("relay cli verbs: vyre commands lists every verb run() handles", async t => {
  const root = tempHome(t);
  const r = await run(root, ["commands", "relay", "--json"]);
  assert.equal(r.code, 0, r.out);
  const verbs = JSON.parse(r.stdout).commands[0].verbs;
  assert.deepEqual(verbs.map(v => v.verb), ["status", "pair", "devices", "remove", "rename", "trust", "on", "off", "pin", "unpin"]);
  assert.deepEqual(verbs.filter(v => v.read).map(v => v.verb), ["status", "devices"]);
  assert.ok(verbs.filter(v => !v.read).every(v => v.person), "every change asks for a person");
  assert.deepEqual(verbs.find(v => v.verb === "rename").args, [{ name: "id", required: true }, { name: "name", required: true, repeat: true }]);
  assert.deepEqual(verbs.find(v => v.verb === "on").flags.map(f => f.name), ["url"]);
});

test("relay cli verbs: --view pair is a qr frame of the address, with the same data as --json", async t => {
  const { root, url } = await world(t);
  assert.equal((await run(root, ["relay", "on", "--url", url])).code, 0);
  const r = await run(root, ["relay", "pair", "--view"]);
  assert.equal(r.code, 0, r.out);
  const f = r.stdout.trim().split("\n").map(l => JSON.parse(l));
  assert.equal(f.length, 2, "one frame, then done: no QR blocks drawn as text");
  assert.equal(f[0].cmd, "relay pair");
  assert.equal(f[0].view.kind, "qr");
  assert.equal(f[0].view.text, f[0].data.url);
  assert.match(f[0].view.caption, /works once, for 10 minutes/);
  assert.deepEqual(f[1], { v: 1, done: true, exit: 0 });
  const s = JSON.parse((await run(root, ["relay", "status", "--view"])).stdout.split("\n")[0]);
  assert.deepEqual([s.view.kind, s.view.title, s.data.enabled], ["card", "Relay", true]);
});
