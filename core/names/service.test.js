// @ts-check
// The names service against fakes: which names can be had, the claim that holds a name and publishes nothing, a taken name, release, and the move notice.
// Nothing here reaches a network, a certificate authority or another product. The directory's own signing and the recovery flow are in directory.test.js.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as config from "../config/index.js";
import { names, checkName } from "./service.js";
import { tempHome } from "../../test/helpers.js";

/** A service on a fake directory. `directory` overrides what the directory answers. */
function world(t, directory = undefined) {
  const root = tempHome(t);
  const cfg = config.load(root);
  const emitted = [];
  const ctx = { config: cfg, paths: config.ensure(root), log: () => {}, events: { emit: (type, payload) => emitted.push({ type, payload }) } };
  const held = new Set();
  const dir = directory || {
    claim: async name => { if (held.has(name)) throw new Error("someone else has that name"); held.add(name); return { code: "abcd-efgh-ijkl-mnop-qrst-uv" }; },
    check: async name => ({ status: held.has(name) ? "taken" : "ok" }),
    release: async name => { held.delete(name); },
  };
  const svc = names({ ctx, save: p => config.save(p, root, cfg), directory: /** @type {any} */ (dir) });
  return { root, cfg, ctx, svc, emitted, held };
}

test("names: which names can be had", () => {
  assert.equal(checkName("alex").valid, true);
  assert.equal(checkName("Alex-2").name, "alex-2");
  for (const bad of ["a", "1abc", "-abc", "abc-", "a_b", "www", "api", "a--b", "x".repeat(33)]) assert.equal(checkName(bad).valid, false, bad);
});

test("names: a claim holds the name, answers the recovery code once, and serves nothing", async t => {
  const w = world(t);
  const out = /** @type {any} */ (await w.svc.claim("alex"));
  assert.equal(out.recoveryCode, "abcd-efgh-ijkl-mnop-qrst-uv");
  const s = w.svc.status();
  assert.equal(s.phase, "named");
  assert.equal(s.name, "alex");
  assert.deepEqual([s.listening, s.port, s.certificate, s.address], [false, null, null, null]);
  assert.equal(w.cfg.name, "alex");
  assert.ok(!JSON.stringify([s, w.emitted]).includes("abcd-efgh"), "the recovery code is in no status or event");
  assert.deepEqual(w.emitted.map(e => e.type), ["name.claimed"]);
  assert.ok(!/tailscale|tailnet/i.test(JSON.stringify(s)), "nothing in the status names another product");
});

test("names: a taken name fails the claim with a reason and saves nothing", async t => {
  const w = world(t);
  w.held.add("alex");
  const out = /** @type {any} */ (await w.svc.claim("alex"));
  assert.equal(out.recoveryCode, null);
  assert.equal(w.svc.status().phase, "failed");
  assert.match(String(w.svc.status().why), /someone else/);
  assert.notEqual(w.cfg.name, "alex");
  assert.deepEqual(w.emitted, []);
});

test("names: a claim needs a valid name and the directory, and says so", async t => {
  const w = world(t);
  assert.throws(() => w.svc.claim("vyre"), /reserved/);
  assert.throws(() => w.svc.claim(""), /./);
  const bare = names({ ctx: /** @type {any} */ (w.ctx), save: () => {} });
  assert.throws(() => bare.claim("alex"), /needs the name directory/);
  assert.deepEqual([(await bare.check("alex")).available, (await bare.check("alex")).why], [false, "the name directory is not set up on this machine"]);
});

test("names: release gives the name back and clears the address", async t => {
  const w = world(t);
  await w.svc.claim("alex");
  w.cfg.network.address = "https://alex.vyre.run";
  const s = await w.svc.release();
  assert.ok(!w.held.has("alex"));
  assert.equal(s.phase, "idle");
  assert.ok(!w.cfg.network.address);
  assert.ok(w.emitted.some(e => e.type === "name.released"));
});

test("names: a box whose name support moved to another server is told once, and a normal answer tells nothing", async t => {
  const answers = [{ name: null, moved: { name: "alex", at: 5 } }, { name: null, moved: { name: "alex", at: 5 } }, { name: null }];
  const w = world(t, { mine: async () => answers.shift() });
  w.cfg.name = "alex";
  w.cfg.network.via = "vyre.run";
  await w.svc.watch();
  await w.svc.watch();
  await w.svc.watch();
  assert.deepEqual(w.emitted.filter(e => e.type === "name.moved").map(e => e.payload), [{ name: "alex.vyre.run", at: 5 }]);
});
