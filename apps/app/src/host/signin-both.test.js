// A space, a username and a password sign in on the computer app and on the web. The door is the real createLoginService. A device id the space has already seen rings nobody.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHost } from "./host-core.js";
import { deviceLabelFor } from "./wanted.js";
import { createLoginService } from "../../../../kernel/identity/space-login.js";
import { world, BASE } from "../../../../names/worker/testing.js";
import worker from "../../../../names/worker/index.js";

const PASSWORD = "correct horse battery staple";
const COMPUTER = "computer01abcdefgh";
const BROWSER = "webbrowser01abcdef";

const memoryStore = () => { let kept = null; return { load: async () => (kept ? structuredClone(kept) : null), save: async (k) => { kept = structuredClone(k); } }; };

function directory(t) {
  const w = world(t);
  const fetchIn = async (url, init = {}) => {
    const u = new URL(url);
    const headers = new Headers(init.headers || {});
    headers.set("cf-connecting-ip", "203.0.113.9");
    return worker.fetch(new Request(`${BASE}${u.pathname}${u.search}`, { method: init.method || "GET", headers, body: init.body }), w.env);
  };
  return { fetch: fetchIn, base: BASE, now: () => w.clock.t };
}

test("password sign-in on the computer app and the web rings a device once", { timeout: 360000 }, async (t) => {
  assert.equal(deviceLabelFor("mac"), "This computer");
  assert.equal(deviceLabelFor("windows"), "This computer");
  assert.equal(deviceLabelFor(null), "This browser");
  const d = directory(t);
  const rec = new Map();
  const events = [];
  const SPACE_ROW = [{ id: "spc_juniperaaaaaaaa", name: "juniper", role: "member", server: "https://juniper.vyre.run" }];
  const svc = createLoginService({ space: "juniper", store: { get: (k) => rec.get(k), set: (k, v) => rec.set(k, v) }, now: d.now, verifyIdentity: async () => true, isMember: async () => true, describe: async () => ({ role: "member", spaces: SPACE_ROW }), onNewDevice: (e) => events.push(e) });
  const posts = [];
  const fetchAll = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === "juniper.vyre.run" && u.pathname === "/login") {
      const body = JSON.parse(init.body);
      posts.push(body);
      const out = body.op === "begin" ? svc.begin(body, "203.0.113.5") : body.op === "finish" ? await svc.finish(body, "203.0.113.5") : await svc.register(body).catch((e) => ({ error: { code: e.code, message: e.message } }));
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    }
    return d.fetch(url, init);
  };
  const one = createHost({ store: memoryStore(), directory: d.base, fetch: fetchAll, now: d.now });
  await one.call("onboard.person.create", { username: "blair", password: PASSWORD, confirm: PASSWORD });
  assert.deepEqual(await svc.register(await one.registerLogin("juniper", PASSWORD)), { ok: true, username: "blair" });

  const computer = () => createHost({ store: memoryStore(), directory: d.base, fetch: fetchAll, now: d.now, signin: { deviceId: async () => COMPUTER, label: deviceLabelFor("mac") } });
  const first = await computer().call("onboard.signin", { space: "juniper.vyre.run", username: "blair", password: PASSWORD });
  assert.equal(first.username, "blair");
  assert.equal("presence" in first || "prompt" in first || "approval" in first, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].label, "This computer");
  const finish = posts.filter((p) => p.op === "finish");
  assert.equal(finish.at(-1).device.label, "This computer");
  assert.equal(finish.at(-1).device.id, COMPUTER);

  const again = await computer().call("onboard.signin", { space: "juniper.vyre.run", username: "blair", password: PASSWORD });
  assert.equal(again.username, "blair");
  assert.equal(events.length, 1, "the same computer signs in again and rings nobody");

  const web = createHost({ store: memoryStore(), directory: d.base, fetch: fetchAll, now: d.now, signin: { deviceId: async () => BROWSER, label: deviceLabelFor(null) } });
  const signed = await web.call("onboard.signin", { space: "juniper.vyre.run", username: "blair", password: PASSWORD });
  assert.equal(signed.id, first.id);
  assert.equal((await web.call("identity.status")).unlocked, true);
  assert.equal(events.length, 2);
  assert.equal(events[1].label, "This browser");
  assert.equal(posts.filter((p) => p.op === "finish").at(-1).device.label, "This browser");
  assert.equal(posts.every((p) => !JSON.stringify(p).includes(PASSWORD)), true, "the password never went to the space");
});
