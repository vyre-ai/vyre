// Continue with GitHub fills the name and the photo. The door is the real createLoginService (githubFinish and linkGithub) and the assertion is checked by verifyGithubAssertion.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createHost } from "./host-core.js";
import { createLoginService, verifyGithubAssertion, GH_ASSERT_TAG } from "../../../../kernel/identity/space-login.js";
import { world, BASE } from "../../../../names/worker/testing.js";
import worker from "../../../../names/worker/index.js";

const PASSWORD = "correct horse battery staple";
const AVATAR = "https://avatars.githubusercontent.com/u/7?v=4";
const HOSTILE = "https://evil.example/pic.png";
const SPACE_ROW = [{ id: "spc_juniperaaaaaaaa", name: "juniper", role: "owner", server: "https://juniper.vyre.run" }];

const memoryStore = () => { let kept = null; return { load: async () => (kept ? structuredClone(kept) : null), save: async (k) => { kept = structuredClone(k); } }; };

function identityKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("base64url");
  return { pub, sign: (/** @type {Buffer} */ m) => crypto.sign(null, m, privateKey).toString("base64url") };
}

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

test("Continue with GitHub keeps the name and a GitHub photo, and drops any other photo address", { timeout: 360000 }, async (t) => {
  const d = directory(t);
  const relay = identityKey();
  const rec = new Map();
  const svc = createLoginService({ space: "juniper", relayPub: relay.pub, store: { get: (k) => rec.get(k), set: (k, v) => rec.set(k, v) }, now: d.now, verifyIdentity: async () => true, isMember: async () => true, describe: async () => ({ role: "owner", spaces: SPACE_ROW }) });
  const posts = [];
  const assertion = (space) => {
    const now = d.now();
    const payload = Buffer.from(JSON.stringify({ v: 1, id: "4242", login: "piawalker", name: "Pia Walker", space, iat: now, exp: now + 120_000 })).toString("base64url");
    return `${payload}.${relay.sign(Buffer.from(`${GH_ASSERT_TAG}\n${payload}`))}`;
  };
  const fetchAll = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === "juniper.vyre.run" && u.pathname === "/login") {
      const body = JSON.parse(init.body);
      posts.push(body);
      try {
        const out = body.op === "github" ? await svc.githubFinish(body, "203.0.113.5") : body.op === "link-github" ? await svc.linkGithub(body) : body.op === "begin" ? svc.begin(body, "203.0.113.5") : body.op === "finish" ? await svc.finish(body, "203.0.113.5") : await svc.register(body);
        return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: { code: e.code || "failed", message: e.message } }), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    if (u.pathname === "/v1/ids/spaces") {
      const body = JSON.parse(init.body);
      const who = verifyGithubAssertion(body.assertion, relay.pub, "names", d.now);
      const ok = Boolean(who && who.id === "4242");
      return new Response(JSON.stringify(ok ? { data: { username: "pia", spaces: [{ name: "juniper", address: "juniper.vyre.run" }] } } : { error: { code: "bad_login" } }), { status: ok ? 200 : 403 });
    }
    if (u.pathname.startsWith("/v1/ids/spaces/")) return new Response(JSON.stringify({ data: {} }), { status: 200 });
    return d.fetch(url, init);
  };
  const githubFor = (avatar) => ({ start: async () => ({ ok: true, session: { ticket: "t", cv: "c" }, user: { id: 4242, login: "piawalker", displayName: "Pia Walker", avatarUrl: avatar } }), assert: async (_s, audience) => assertion(audience) });

  const store1 = memoryStore();
  const one = createHost({ store: store1, directory: d.base, fetch: fetchAll, now: d.now, github: githubFor(AVATAR) });
  await one.call("onboard.person.create", { username: "pia", password: PASSWORD, confirm: PASSWORD });
  await one.call("identity.heal");
  assert.deepEqual(await svc.register(await one.registerLogin("juniper", PASSWORD)), { ok: true, username: "pia" });
  const kept = await store1.load();
  await store1.save({ ...kept, signin: { space: "juniper" }, spaces: SPACE_ROW });
  const linked = await one.call("identity.github.link", { session: { ticket: "t", cv: "c" }, user: { id: 4242, login: "piawalker", displayName: "Pia Walker", avatarUrl: AVATAR } });
  assert.equal(linked.linked, true);
  const status1 = await one.call("identity.status");
  assert.equal(status1.display, "Pia Walker");
  assert.equal(status1.photo, AVATAR);
  assert.equal(status1.github, "piawalker");
  const link = posts.find((p) => p.op === "link-github");
  assert.equal(verifyGithubAssertion(link.assertion, relay.pub, "juniper", d.now).id, "4242");

  const two = createHost({ store: memoryStore(), directory: d.base, fetch: fetchAll, now: d.now, github: githubFor(HOSTILE) });
  const found = await two.call("onboard.signin.github");
  assert.equal(found.login, "pia");
  const opened = await two.call("onboard.signin.unlock", { password: PASSWORD });
  assert.equal(opened.username, "pia");
  const status2 = await two.call("identity.status");
  assert.equal(status2.display, "Pia Walker");
  assert.equal(status2.photo, undefined, "a photo address that is not a GitHub avatar is not stored");
  assert.equal(posts.some((p) => p.op === "github"), true);
  assert.equal(posts.every((p) => !JSON.stringify(p).includes(PASSWORD)), true, "the password never went to the space");
});
