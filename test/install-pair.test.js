// @ts-check
// An install code adopts the person who signed it, once. A second use is refused, an expired code is refused, and the setup page locks.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mintPairCode, verifyPairCode, installCommand, PAIR_CODE_LEN, personIdOfKey } from "../lib/pair-code.js";
import { mintPairCode as mintInApp } from "../relay/client/pair-install.js";
import { redeemInstallCode, registerInstallPair, publishedDeviceKeys } from "../core/wink/install-pair.js";
import { registerPairInstall } from "../core/spaces/pair-install.js";
import { createSetupPage } from "../core/wink/setup-http.js";
import { createSetupKey, setupFingerprint } from "../relay/client/setup.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = () => 1_700_000_000_000;
const PERSON = `per_${"a".repeat(26)}`;

function identity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  return { pub: pub.toString("base64url"), sign: (/** @type {Uint8Array} */ m) => crypto.sign(null, Buffer.from(m), privateKey) };
}

function metaOf() {
  const m = new Map();
  return { get: (/** @type {string} */ k) => (m.has(k) ? m.get(k) : null), set: (/** @type {string} */ k, /** @type {any} */ v) => { m.set(k, v); }, del: (/** @type {string} */ k) => { m.delete(k); } };
}

/** @param {ReturnType<typeof metaOf>} meta @param {{ adopt?: (owner: any) => any }} [o] */
function ctxOf(meta, o = {}) {
  /** @type {{ tool: string, owner: any }[]} */ const calls = [];
  return {
    calls,
    call: async (/** @type {string} */ tool) => {
      calls.push({ tool, owner: meta.get("owner") });
      if (tool === "spaces.owner.adopt") return o.adopt ? o.adopt(meta.get("owner")) : { data: { ok: true } };
      return { data: {} };
    },
    events: { emit() {} },
  };
}

test("the app and the server mint the same code, and the person id is the chain id", async () => {
  const me = identity();
  const secret = crypto.randomBytes(16);
  const fp = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(16);
  const random = () => nonce;
  const sign = (/** @type {Uint8Array} */ m) => me.sign(m);
  const server = await mintPairCode({ person: PERSON, publicKey: me.pub, secret, fingerprint: fp, now: NOW, random, sign });
  const app = await mintInApp({ person: PERSON, publicKey: me.pub, secret, fingerprint: fp, now: NOW, random, sign: async (m) => new Uint8Array(me.sign(m)) });
  assert.equal(app.code, server.code);
  assert.equal(server.code.length, PAIR_CODE_LEN);
  assert.equal(server.person, PERSON);
  assert.notEqual(server.person, personIdOfKey(Buffer.from(me.pub, "base64url")));
  const v = verifyPairCode(server.code, NOW);
  assert.equal(v.ok && v.person, PERSON);
  const line = `curl -fsSL vyre.run/i | VYRE_CODE=${server.code} VYRE_STORE=auto sh`;
  assert.equal(installCommand("linux", server.code), line);
  assert.equal(installCommand("mac", server.code), line);
  assert.ok(!line.includes("--code"));
  assert.ok(line.length < 500);
});

test("redeem writes the owner, then adopts that person, and a second use is locked", async () => {
  const me = identity();
  const secret = crypto.randomBytes(16);
  const fp = crypto.randomBytes(16);
  const made = await mintPairCode({ person: PERSON, publicKey: me.pub, secret, fingerprint: fp, now: NOW, sign: (m) => me.sign(m) });
  const meta = metaOf();
  const ctx = ctxOf(meta);
  const publishedKeys = async () => [me.pub];
  const first = await redeemInstallCode({ ctx, meta, now: NOW, publishedKeys }, made.code);
  assert.equal(first.person, made.person);
  assert.equal(ctx.calls[0].tool, "spaces.owner.adopt");
  assert.equal(ctx.calls[0].owner.identity, made.person);
  assert.equal(meta.get("owner").identity, made.person);
  await assert.rejects(() => redeemInstallCode({ ctx, meta, now: NOW, publishedKeys }, made.code), (/** @type {any} */ e) => e.code === "locked" && /Make a new install line/.test(e.message));
});

test("redeem confirms the published key before it writes, and a refusal leaves the server unowned", async () => {
  const me = identity();
  const made = await mintPairCode({ person: PERSON, publicKey: me.pub, secret: crypto.randomBytes(16), fingerprint: crypto.randomBytes(16), now: NOW, sign: (m) => me.sign(m) });
  const meta = metaOf();
  const ctx = ctxOf(meta);
  ctx.call = async (/** @type {string} */ tool) => {
    ctx.calls.push({ tool, owner: meta.get("owner") });
    if (tool === "spaces.identity.confirm-key") return { error: { code: "denied", message: "That key is not one this person has published. Pair again from the Vyre app." } };
    return { data: { ok: true } };
  };
  await assert.rejects(() => redeemInstallCode({ ctx, meta, now: NOW }, made.code), (/** @type {any} */ e) => e.code === "denied" && /published/.test(e.message));
  assert.equal(meta.get("owner"), null);
  assert.deepEqual(ctx.calls.map((/** @type {any} */ c) => c.tool), ["spaces.identity.confirm-key"]);
});

test("an expired code and a bad signature are refused, and a failed adopt rolls the owner back", async () => {
  const me = identity();
  const secret = crypto.randomBytes(16);
  const fp = crypto.randomBytes(16);
  const publishedKeys = async () => [me.pub];
  const made = await mintPairCode({ person: PERSON, publicKey: me.pub, secret, fingerprint: fp, now: NOW, sign: (m) => me.sign(m), ttlMs: -200_000 });
  const meta = metaOf();
  await assert.rejects(() => redeemInstallCode({ ctx: ctxOf(meta), meta, now: NOW, publishedKeys }, made.code), (/** @type {any} */ e) => e.code === "expired");
  const fresh = await mintPairCode({ person: PERSON, publicKey: me.pub, secret, fingerprint: fp, now: NOW, sign: (m) => me.sign(m) });
  const raw = Buffer.from(fresh.code, "base64url");
  raw[120] ^= 0xff;
  const bad = raw.toString("base64url");
  await assert.rejects(() => redeemInstallCode({ ctx: ctxOf(metaOf()), meta: metaOf(), now: NOW, publishedKeys }, bad), (/** @type {any} */ e) => e.code === "denied");
  const meta2 = metaOf();
  const ctx2 = ctxOf(meta2, { adopt: () => ({ error: { code: "unavailable", message: "no" } }) });
  await assert.rejects(() => redeemInstallCode({ ctx: ctx2, meta: meta2, now: NOW, publishedKeys }, fresh.code), (/** @type {any} */ e) => e.code === "unavailable");
  assert.equal(meta2.get("owner"), null);
});

test("redeem adopts only when the published key for that person id matches, and fails closed otherwise", async () => {
  const me = identity();
  const other = identity();
  const made = await mintPairCode({ person: PERSON, publicKey: me.pub, secret: crypto.randomBytes(16), fingerprint: crypto.randomBytes(16), now: NOW, sign: (m) => me.sign(m) });
  const mismatch = metaOf();
  await assert.rejects(() => redeemInstallCode({ ctx: ctxOf(mismatch), meta: mismatch, now: NOW, publishedKeys: async () => [other.pub] }, made.code), (/** @type {any} */ e) => e.code === "denied" && /published/.test(e.message));
  assert.equal(mismatch.get("owner"), null);
  const down = metaOf();
  await assert.rejects(() => redeemInstallCode({ ctx: ctxOf(down), meta: down, now: NOW, publishedKeys: async () => { throw Object.assign(new Error("down"), { code: "unreachable" }); } }, made.code), (/** @type {any} */ e) => e.code === "unavailable" && /directory/.test(e.message));
  assert.equal(down.get("owner"), null);
  const missing = metaOf();
  await assert.rejects(() => redeemInstallCode({ ctx: ctxOf(missing), meta: missing, now: NOW, publishedKeys: async () => { throw Object.assign(new Error("no"), { code: "not_found" }); } }, made.code), (/** @type {any} */ e) => e.code === "denied");
  assert.equal(missing.get("owner"), null);
  assert.deepEqual(publishedDeviceKeys({ entries: [{ kind: "device", pub: me.pub }, { kind: "device", pub: other.pub, held: "web" }, { kind: "code", pub: other.pub }] }), [me.pub]);
});

test("the setup page takes the code in the body, locks, and refuses a code in the address", async () => {
  const me = identity();
  const made = await mintPairCode({ person: PERSON, publicKey: me.pub, secret: crypto.randomBytes(16), fingerprint: crypto.randomBytes(16), now: NOW, sign: (m) => me.sign(m) });
  const meta = metaOf();
  const ctx = ctxOf(meta);
  const publishedKeys = async () => [me.pub];
  const page = createSetupPage({ redeem: (code) => redeemInstallCode({ ctx, meta, now: NOW, publishedKeys }, code), locked: () => Boolean(meta.get("install_setup_locked") || meta.get("owner")) });
  const server = page.start({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const q = await fetch(`http://127.0.0.1:${port}/setup?code=${made.code}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `code=${made.code}` });
    assert.equal(q.status, 400);
    assert.equal(meta.get("owner"), null);
    const ok = await fetch(`http://127.0.0.1:${port}/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: made.code }) });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /This server is paired/);
    assert.equal(meta.get("owner").identity, made.person);
    const again = await fetch(`http://127.0.0.1:${port}/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: made.code }) });
    assert.equal(again.status, 403);
    const get = await fetch(`http://127.0.0.1:${port}/setup`);
    assert.equal(get.status, 403);
    assert.match(await get.text(), /This server is paired/);
  } finally { await page.stop(); }
});

test("issue returns the line and never the signing key, and complete pairs from the ticket", async () => {
  const me = identity();
  const meta = metaOf();
  /** @type {Map<string, any>} */ const tools = new Map();
  /** @type {{ qr?: string, person?: string }} */ const saw = {};
  const ctx = {
    tool: (/** @type {string} */ name, /** @type {any} */ def) => tools.set(name, def),
    call: async (/** @type {string} */ tool, /** @type {any} */ input) => {
      if (tool === "spaces.identity.device") return { data: { deviceKey: me.pub } };
      if (tool === "spaces.identity.self") return { data: { id: PERSON } };
      if (tool === "spaces.identity.sign") return { data: { sig: Buffer.from(me.sign(Buffer.from(String(input.message), "base64url"))).toString("base64url") } };
      return { data: {} };
    },
  };
  registerInstallPair({
    ctx, meta, now: NOW,
    ticket: async () => "vyre://wink/2?t=abc",
    pair: async (qr, person) => { saw.qr = qr; saw.person = person; return { pairing: "pr_test" }; },
  });
  registerPairInstall({
    tool: (/** @type {string} */ name, /** @type {any} */ def) => tools.set(name, def),
    call: async (/** @type {string} */ tool, /** @type {any} */ input) => {
      if (tool === "wink.install.issue") return { data: await tools.get("wink.install.issue").run(input) };
      return ctx.call(tool, input);
    },
  });
  const issued = await tools.get("spaces.pair.install").run({ kind: "mac", name: "juniper" });
  assert.equal(issued.person, PERSON);
  assert.equal(issued.os, "mac");
  assert.equal(issued.command, installCommand("mac", issued.code));
  assert.equal(issued.line, issued.command);
  const again = await tools.get("wink.install.issue").run({ os: "linux" });
  assert.equal(again.command, installCommand("linux", again.code));
  assert.equal(verifyPairCode(issued.code, NOW).ok, true);
  assert.equal(JSON.stringify(issued).includes("privateKey"), false);
  const status = await tools.get("wink.install.status").run();
  assert.equal(status.issued, true);
  assert.equal(status.owned, false);
  const done = await tools.get("wink.install.complete").run();
  assert.equal(done.pairing, "pr_test");
  assert.equal(saw.qr, "vyre://wink/2?t=abc");
  assert.equal(saw.person, issued.person);
  assert.equal(JSON.stringify(done).includes("privateKey"), false);
  meta.set("owner", { kind: "identity", id: issued.person, identity: issued.person });
  const owned = await tools.get("wink.install.complete").run();
  assert.equal(owned.owned, true);
});

test("the tools are declared once, outward for the owner-changing ones, and open to a proven assistant", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "core/wink/module.json"), "utf8"));
  const byName = new Map(manifest.does.tools.filter((/** @type {any} */ t) => t && t.name).map((/** @type {any} */ t) => [t.name, t]));
  assert.equal(byName.has("spaces.pair.install"), false);
  const spaces = JSON.parse(fs.readFileSync(path.join(ROOT, "core/spaces/module.json"), "utf8"));
  const spaceTools = new Map(spaces.does.tools.filter((/** @type {any} */ t) => t && t.name).map((/** @type {any} */ t) => [t.name, t]));
  assert.equal(spaces.main, "boot.js");
  assert.equal(spaceTools.get("spaces.pair.install").outward, true);
  assert.deepEqual(spaceTools.get("spaces.pair.install").covers, ["wink.install.issue"]);
  assert.equal(byName.get("wink.install.issue").outward, true);
  assert.equal(byName.get("wink.install.complete").outward, true);
  assert.equal(byName.get("wink.install.status").effect, "read");
  assert.equal(byName.get("wink.server.install-redeem").reach, "modules");
  const reach = fs.readFileSync(path.join(ROOT, "core/modules/agent-reach.js"), "utf8");
  const open = reach.slice(reach.indexOf("export const OPEN"), reach.indexOf("export const ASK_FIRST"));
  const ask = reach.slice(reach.indexOf("export const ASK_FIRST"), reach.indexOf("export const WEB_REACH"));
  for (const name of ["spaces.pair.install", "wink.install.issue", "wink.install.status", "wink.install.complete"]) {
    assert.ok(open.includes(`"${name}"`), name);
    assert.ok(!ask.includes(`"${name}"`), `${name} stays open so the Gate card can land`);
  }
  const sign = fs.readFileSync(path.join(ROOT, "core/spaces/index.js"), "utf8");
  assert.ok(sign.includes("vyre-pair-install-v1\\n"));
  const box = fs.readFileSync(path.join(ROOT, "scripts/install-box.sh"), "utf8");
  const mac = fs.readFileSync(path.join(ROOT, "scripts/install-mac-server.sh"), "utf8");
  assert.match(box, /\{43\}\$\|\^\[A-Za-z0-9_-\]\{239\}/);
  assert.match(mac, /length===179&&b\[0\]===2\?b\.subarray\(69,85\)/);
  assert.match(mac, /unset VYRE_CODE/);
});

test("a setup key's fingerprint is what an install code carries", async () => {
  const key = await createSetupKey();
  const fp = await setupFingerprint(key.spki);
  assert.equal(fp.length, 16);
});

test("the person's own issue runs, and an agent's issue and complete wait at the Gate", { timeout: 120_000 }, async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  const { start } = await import("../core/daemon/index.js");
  const { tempHome, present, asOwner } = await import("./helpers.js");
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", modules: { disable: ["agents", "computers"] } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller, /** @type {any} */ meta) => d.registry.call(tool, input, caller, meta);
  const person = await call("spaces.pair.install", { kind: "linux", name: "juniper" }, "cli");
  assert.notEqual(person.error && person.error.code, "no_such_tool");
  assert.notEqual(person.error && person.error.code, "held_for_approval");
  assert.ok(!(person.error && /Nothing ran/.test(person.error.message || "")));
  if (!person.error) assert.match(person.data.command, /^curl -fsSL vyre\.run\/i \| VYRE_CODE=\S+ VYRE_STORE=auto sh$/);
  for (const tool of ["spaces.pair.install", "wink.install.issue", "wink.install.complete"]) {
    const held = await call(tool, tool.endsWith("complete") ? {} : { kind: "mac" }, "mcp:agent:kit", { thread: "thr_install" });
    assert.equal(held.error && held.error.code, "held_for_approval", tool);
    assert.match(held.error.message, /Nothing ran/);
  }
  const unproven = await call("wink.install.issue", { os: "linux" }, "mcp:agent:kit");
  assert.equal(unproven.error && unproven.error.code, "denied");
});
