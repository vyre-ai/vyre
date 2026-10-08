// @ts-check
// The page's own connection to a real vyred over the real Node relay: admitted only with the page's key, able to
// call the setup allowlist and nothing else. (core/relay/setup.test.js is the box's half; this is the page's.)
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { start } from "../../core/daemon/index.js";
import { createRelay } from "../../relay/node/server.js";
import { tempHome } from "../../test/helpers.js";
import * as client from "../../relay/client/setup.js";
import { openChannel, request } from "../../relay/client/client.js";
import { webCrypto } from "../../relay/client/webcrypto.js";
import { nodeCrypto } from "../../relay/client/nodecrypto.js";
import { utf8 } from "../../relay/client/bytes.js";
import { connectSetup } from "./setupchannel.js";

const lenient = {
  required: () => false,
  verify: async () => ({ ok: true, method: "passkey", keyId: "k1" }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
  summary: async () => "",
  covered: () => false,
  coverage: () => ({ covered: false, since: null, expires: null }),
  enrolled: /** @type {any[]} */ ([]),
  removed: /** @type {any[]} */ ([]),
  enroll(k) { this.enrolled.push(k); return { id: `kh${this.enrolled.length}`, kind: k.kind, name: k.name }; },
};

test("page connection: connectSetup is admitted with the page's key, calls the allowlist, and is refused everything else", async t => {
  // A real vyred with the relay module and this machine posing as Linux (a Mac refuses the relay's tickets until vyre-core).
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", /** @type {any} */ (real)));
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "harlow", transcripts: [],
    network: { name: "harlow" }, relay: { enabled: false, url: base }, modules: { disable: ["names", "onboard"] } }));
  // The setup session starts the way the install script starts it: the code in the environment at vyred's boot (relay.setup.begin is
  // for modules only, and this test is not one).
  const key = await client.createSetupKey();
  const secret = crypto.randomBytes(16);
  const code = await client.setupCode(secret, key.spki);
  const saved = { code: process.env.VYRE_SETUP_CODE, at: process.env.VYRE_SETUP_CODE_AT };
  process.env.VYRE_SETUP_CODE = code;
  process.env.VYRE_SETUP_CODE_AT = String(Math.floor(Date.now() / 1000));
  t.after(() => { for (const [k, v] of [["VYRE_SETUP_CODE", saved.code], ["VYRE_SETUP_CODE_AT", saved.at]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const d = await start({ presence: lenient, root, log: () => {} });
  t.after(() => d.stop());
  let status;
  for (let i = 0; i < 100 && !(status && status.registered); i++) { status = (await d.registry.call("relay.setup.status", {}, "cli")).data; if (!(status && status.registered)) await new Promise(r => setTimeout(r, 30)); }
  assert.equal(status && status.registered, true, "the offer is registered at the relay");
  const { offer, name } = await client.resolveSetup(secret, { relay: base, crypto: nodeCrypto() });
  assert.equal(name, "harlow");

  const box = await connectSetup({ openChannel, request, setupHello: client.setupHello, webCrypto, utf8 }, { offer, key, secret });
  t.after(() => box.close());
  const info = await box.call("system.info");
  assert.ok(info && typeof info === "object", "an allowlisted tool answers with its data");
  const st = await box.call("relay.setup.status");
  assert.equal(st.state, "paired");
  assert.equal(st.words, (await client.setupWords(offer.box, secret)).join(" "), "the words the page computes are the ones the box holds");
  assert.deepEqual(await box.events("relay.paired", 0), [], "an allowed event type answers (nothing has paired yet)");
  await assert.rejects(box.events("vault.changed", 0), e => e.status === 404, "any other event type is refused");
  // The follower reads that list (a poll), hears an error as the end, and stops when told.
  let ended = null;
  const stop = box.follow("vault.changed", () => {}, e => { ended = e; }, 20);
  await new Promise(r => setTimeout(r, 120));
  assert.ok(ended && ended.status === 404, "a type the channel may not read ends the follower with the box's answer");
  const stop2 = box.follow("relay.paired", () => assert.fail("nothing has paired"), () => assert.fail("no error expected"), 20);
  await new Promise(r => setTimeout(r, 100));
  stop(); stop2();
  await assert.rejects(box.call("vault.list"), e => e.status >= 400);
  await assert.rejects(box.call("relay.setup.end"), e => e.status >= 400);

  // Another browser holding only the code (a key that does not hash to its fingerprint) is not admitted.
  const other = await client.createSetupKey();
  await assert.rejects(connectSetup({ openChannel, request, setupHello: client.setupHello, webCrypto, utf8 }, { offer, key: other, secret, timeout: 3000 }));
});
