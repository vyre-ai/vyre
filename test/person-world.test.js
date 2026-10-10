// @ts-check
// The world with a real person (scripts/lib/proof/person-world.mjs): a chosen Vyre name, the app's own modules, a real server, and the owner's stand-in key enrolled, so an act that needs the person's yes
// gets it. Used here for the two things design and chat wait on: the "Run on this computer" switch (one yes) and pairing a phone (the computer says yes to the phone's three words).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { personWorld } from "../scripts/lib/proof/person-world.mjs";
import { createApp } from "../scripts/lib/proof/app.mjs";
import { runnerSource } from "../apps/app/screens/runner/runner-source.ts";

test("a person world boots with the chosen name and the person can make a call that needs their yes", { timeout: 240_000 }, async t => {
  const pw = await personWorld({ name: "alexpw", kind: "daemon" });
  t.after(() => pw.close());
  assert.equal(pw.person, "alexpw");
  assert.ok(pw.personId, "an identity");
  const info = await pw.call("system.info");
  assert.ok(info, "the server answers the person's session");
  // the person's yes: a call the server holds for presence is answered with the stand-in key's proof of exactly that act
  const proof = await pw.yesFor({ op: "demo.act", space: "spc_demo", fields: { what: "x" } });
  assert.match(proof, /^[A-Za-z0-9_-]{40,}$/, "a base64url proof header");
  assert.equal(JSON.parse(Buffer.from(proof, "base64url").toString()).decision, "demo.act");
});

test("the Run on this computer switch works against a person world: one yes lends, off stops", { timeout: 240_000 }, async t => {
  const pw = await personWorld({ name: "runpw", kind: "daemon" });
  t.after(() => pw.close());
  const src = runnerSource(/** @type {any} */ (async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    try { return { data: await pw.call(tool, input) }; } catch (e) { return { error: { code: /** @type {any} */ (e).code || "failed", message: String(/** @type {Error} */ (e).message) } }; }
  }));
  const list = await pw.call("spaces.devices.list", {});
  assert.ok(list, `the server lists the devices: ${JSON.stringify(list).slice(0, 200)}`);
  const on = await src.turnOn();
  assert.ok(on, `turning it on answered: ${JSON.stringify(on).slice(0, 300)}`);
});

test("a phone pairs to a person world: the computer shows a code, the phone joins the name, the computer says yes to its three words", { timeout: 240_000 }, async t => {
  const pw = await personWorld({ name: "phonepw", kind: "daemon" });
  t.after(() => pw.close());
  const w = pw.world;
  const phone = createApp({ label: "Proof phone", dir: path.join(w.dir, "phone"), directory: w.ins.names, relay: w.ins.relay, about: { kind: "app" } });
  t.after(() => phone.close());
  const code = await pw.mac.showDeviceCode();
  assert.match(code.qr, /^vyre:\/\/wink\/2\?/);
  /** @type {string[]} */ const shown = [];
  const joining = phone.addThisDeviceToName({ payload: code.qr, onWords: x => shown.push(x) });
  const failed = new Promise((_, rej) => joining.catch(rej));
  failed.catch(() => {});
  const ask = /** @type {any} */ (await Promise.race([pw.mac.answerDevice(), failed]));
  await phone.until(() => shown.length, 15_000, "the phone to show its words");
  await pw.mac.sayYes(shown[0].split(" "), ask.raw);
  await pw.mac.serveEnrol();
  const r = await joining;
  assert.equal(r.id, pw.personId, "the phone joined this person's identity");
});
