// @ts-check
// The names service against fakes: which names can be had, serving a space's name, unserving it, and the move notice.
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
    check: async name => ({ status: held.has(name) ? "taken" : "ok" }),
  };
  const svc = names({ ctx, save: p => config.save(p, root, cfg), directory: /** @type {any} */ (dir) });
  return { root, cfg, ctx, svc, emitted, held };
}

test("names: which names can be had", () => {
  assert.equal(checkName("alex").valid, true);
  assert.equal(checkName("Alex-2").name, "alex-2");
  for (const bad of ["a", "1abc", "-abc", "abc-", "a_b", "www", "api", "a--b", "x".repeat(33)]) assert.equal(checkName(bad).valid, false, bad);
});

test("names: serving a name sets it, makes no recovery code, and publishes nothing by itself", async t => {
  const w = world(t);
  const out = /** @type {any} */ (w.svc.serve("alex"));
  assert.equal(out.recoveryCode, undefined, "no recovery code is made");
  const s = w.svc.status();
  assert.equal(s.phase, "named");
  assert.equal(s.name, "alex");
  assert.deepEqual([s.listening, s.port, s.certificate, s.address], [false, null, null, null]);
  assert.equal(w.cfg.name, "alex");
  assert.ok(!/recovery/i.test(JSON.stringify([s, w.emitted])), "no status or event speaks of a recovery code");
  assert.deepEqual(w.emitted.map(e => e.type), ["name.claimed"]);
  assert.ok(!/tailscale|tailnet/i.test(JSON.stringify(s)), "nothing in the status names another product");
});

test("names: a name to serve must be one Vyre can use; no claim is made at the directory (a server holds no name)", async t => {
  const w = world(t);
  assert.throws(() => w.svc.serve("vyre"), /reserved/);
  assert.throws(() => w.svc.serve(""), /./);
  assert.equal(w.svc.claim, undefined, "the service has no claim any more");
  assert.equal(w.held.size, 0, "the directory was not asked to hold anything");
  const bare = names({ ctx: /** @type {any} */ (w.ctx), save: () => {} });
  assert.deepEqual([(await bare.check("alex")).available, (await bare.check("alex")).why], [false, "the name directory is not set up on this machine"]);
});

test("names: unserving clears the name and the address", async t => {
  const w = world(t);
  w.svc.serve("alex");
  w.cfg.network.address = "https://alex.vyre.run";
  const s = w.svc.unserve();
  assert.equal(s.phase, "idle");
  assert.ok(!w.cfg.network.address);
  assert.ok(!w.cfg.name);
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
