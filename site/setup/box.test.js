// @ts-check
// The page's own connection to a real vyred over the real Node relay: admitted only with the page's key, able to
// call the setup allowlist and nothing else. (core/relay/setup.test.js is the box's half; this is the page's.)
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
import { connectSetup } from "./box.js";

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
  const d = await start({ presence: lenient, root, log: () => {} });
  t.after(() => d.stop());

  const key = await client.createSetupKey();
  const secret = crypto.randomBytes(16);
  const code = await client.setupCode(secret, key.spki);
  const status = (await d.registry.call("relay.setup.begin", { code }, "module:test")).data;
  assert.equal(status.registered, true);
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
  await assert.rejects(box.call("vault.list"), e => e.status >= 400);
  await assert.rejects(box.call("relay.setup.end"), e => e.status >= 400);

  // Another browser holding only the code (a key that does not hash to its fingerprint) is not admitted.
  const other = await client.createSetupKey();
  await assert.rejects(connectSetup({ openChannel, request, setupHello: client.setupHello, webCrypto, utf8 }, { offer, key: other, secret, timeout: 3000 }));
});
