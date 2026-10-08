// @ts-check
// The add-a-server piece against a REAL server: a vyred with a setup code in its environment (as the installer leaves it), a real relay, the app's real relay client. The app finds the server's offer
// with nothing copied back, the four words it computes are the ones the server holds, and once they are confirmed the setup channel gives it a pairing ticket for its identity and nobody else.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { createRelay } from "../relay/node/server.js";
import { tempHome } from "./helpers.js";
import * as client from "../relay/client/setup.js";
import { openChannel, request } from "../relay/client/client.js";
import { webCrypto } from "../relay/client/webcrypto.js";
import { nodeCrypto } from "../relay/client/nodecrypto.js";
import { utf8 } from "../relay/client/bytes.js";
import { connectSetup } from "../relay/client/setupchannel.js";
import { createAddServer, installLine } from "../apps/app/src/real/add-server.js";

const lenient = {
  required: () => false,
  verify: async () => ({ ok: true, method: "passkey", keyId: "k1" }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
  summary: async () => "",
  covered: () => false,
  coverage: () => ({ covered: false, since: null, expires: null }),
  enrolled: /** @type {any[]} */ ([]),
  removed: /** @type {any[]} */ ([]),
  enroll(/** @type {any} */ k) { this.enrolled.push(k); return { id: `kh${this.enrolled.length}`, kind: k.kind, name: k.name }; },
};
const until = async (/** @type {() => any} */ fn, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 30)); } throw new Error("timed out"); };

test("add-a-server end to end against a real server and relay: the offer is found, the words match, and the channel hands the app a ticket for its own identity only", { timeout: 90_000 }, async t => {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", /** @type {any} */ (real)));
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "harlow", transcripts: [], vault: { keystore: "file" },
    network: { name: "harlow" }, relay: { enabled: false, url: base }, modules: { disable: ["names", "onboard"] } }));

  // What the app does first: make the code, show the line. The server's installer would put the code in its environment.
  let codeSeen = "";
  const app = createAddServer({
    client, relay: base, identity: async () => ({ id: "per_" + "a".repeat(26) }),
    connect: async ({ offer, key, secret }) => connectSetup({ openChannel, request, setupHello: client.setupHello, webCrypto, utf8 }, { offer, key, secret }),
    pair: async qr => { paired.push(qr); }, pollMs: 50,
  });
  const paired = /** @type {string[]} */ ([]);
  await app.begin("plain");
  codeSeen = app.state.code;
  assert.equal(app.state.installLine, installLine(codeSeen, "sqlite"));
  const saved = { code: process.env.VYRE_SETUP_CODE, at: process.env.VYRE_SETUP_CODE_AT };
  process.env.VYRE_SETUP_CODE = codeSeen;
  process.env.VYRE_SETUP_CODE_AT = String(Math.floor(Date.now() / 1000));
  t.after(() => { for (const [k, v] of [["VYRE_SETUP_CODE", saved.code], ["VYRE_SETUP_CODE_AT", saved.at]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const d = await start({ presence: lenient, root, log: () => {} });
  t.after(() => d.stop());

  await until(() => app.state.stage === "found");
  const held = (await d.registry.call("relay.setup.status", {}, "cli")).data;
  assert.equal(app.state.box && app.state.box.words.join(" "), held.words, "the four words the app shows are the ones the server holds (its terminal prints the same)");
  await app.confirmWords();
  assert.equal(app.state.stage, "done", JSON.stringify(app.state.error));
  assert.equal(paired.length, 1);
  assert.match(paired[0], /^vyre:\/\/wink\/2\?t=[A-Za-z0-9_-]{22}&r=/, "the app got a long code to pair with, with no terminal and no copying");
  assert.ok(app.state.memoryMb && app.state.memoryMb > 0, "the server said how much memory it has");
  // the ticket was made for this identity alone: the server remembers who may complete the pairing
  const asking = (await d.registry.call("wink.server.pairing", {}, "cli")).data;
  assert.equal(asking.pairTo, "per_" + "a".repeat(26));
});
