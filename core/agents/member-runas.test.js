// @ts-check
// A member's own thread with an agent acts as HER in the kernel, never as the owner (the owner's rule, 20 Oct 2026: every turn on the account of the person it is for, and with that person's reach). On a real
// vyred with the kernel on and the fake claude, temp home:
//   - B1: agents.ask from a member starts her own thread on her account, keeps run_as, and the thread's kernel session token names her as its person;
//   - B2: a helper (agents.spawn) is the call of the person on the thread's chain: a member's own session starts none (the door), an admin with no account of her own is refused and nothing is recorded,
//     and an admin's helper runs on her account with run_as her;
//   - S2: the owner resuming her thread (agents.resume) brings it back as her, on her account.
// SHIM(presence) `kernelPresence` accepts any proof, as the other real-daemon suites do.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { testHooks, OPEN_WALL } from "../../lib/sandbox/index.js";
import { open as openStore } from "../store/index.js";
import * as config from "../config/index.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
testHooks.wall = OPEN_WALL;
const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "switchboard", "testing", "fake-claude.js");
fs.chmodSync(FAKE, 0o755);
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const ADA = "per_" + "f".repeat(26);
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const until = async (/** @type {() => any} */ fn, /** @type {string} */ what, ms = 20_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 40)); } };

test("a member's own agent thread, its helpers and its resume act as the member, on her own account, never as the owner", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, VYRE_SESSION_SANDBOX_OFF: process.env.VYRE_SESSION_SANDBOX_OFF, FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG };
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", VYRE_SESSION_SANDBOX_OFF: "1", FAKE_CLAUDE_LOG: path.join(root, "claude.log") });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const logs = /** @type {string[]} */ ([]);
  const d = await start({ root, log: (/** @type {any} */ m) => { logs.push(String(m)); }, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await K.gateway.grants.setRole(ownerChain, { person: BEN, role: "member" }, { presence: proof() });
  await K.gateway.grants.setRole(ownerChain, { person: ADA, role: "admin" }, { presence: proof() });
  const tokenOf = async (/** @type {string} */ p) => ({ token: (await K.surfaces.open(K.chains.fromFacts({ kind: "device", device_key_id: "d-" + p.slice(4, 8), person: p, path: "relay" }), {})).token });
  const ownerTok = { token: (await K.surfaces.open(ownerChain, {})).token };
  const asOwner = (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "cli", ownerTok);
  const benTok = await tokenOf(BEN), adaTok = await tokenOf(ADA);
  const asBen = (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "deck", benTok);
  /** @param {string} id */
  const row = id => { const db = openStore(config.paths(root).db); try { const r = /** @type {any} */ (db.prepare("SELECT account, opts FROM threads_runs WHERE id = ?").get(id)); return r ? { account: r.account, opts: r.opts ? JSON.parse(String(r.opts)) : {} } : null; } finally { db.close(); } };
  const subs = () => { const db = openStore(config.paths(root).db); try { return Number(/** @type {any} */ (db.prepare("SELECT COUNT(*) AS n FROM agents_subs").get()).n); } finally { db.close(); } };

  // every kernel session the switchboard asks for, with what its own token says (its signed body, read as the kernel reads it)
  const seen = /** @type {any[]} */ ([]);
  const real = d.registry.deps.kernelSession;
  d.registry.deps.kernelSession = async (/** @type {any} */ q) => {
    const out = await real(q);
    const tok = out ? (typeof out.token === "function" ? await out.token() : out.token) : null;
    const facts = typeof tok === "string" ? (() => { try { return JSON.parse(Buffer.from(tok.split(".")[0], "base64url").toString()); } catch { return null; } })() : null;
    seen.push({ thread: q.thread, runas: q.runas, asker: q.asker, ...(facts ? { person: facts.person, agent: facts.agent } : {}) });
    return out;
  };
  const diag = () => `seen ${JSON.stringify(seen)}; log: ${logs.filter(l => /threads|session|launch|account|refus/i.test(l)).slice(-20).join(" || ")}`;

  assert.ok(!(await asOwner("agents.create", { name: "kit", kind: "agent" })).error);
  assert.ok(!(await asOwner("agents.access.set", { agent: "kit", kind: "person", subject: BEN, level: "use" })).error);
  const benAcct = await asBen("sessions.accounts.add", { provider: "claude", label: "Ben's Claude", kind: "login" });
  assert.equal(benAcct.error, undefined, JSON.stringify(benAcct.error));

  // B1: his ask starts his own thread, on his account, kept as acting for him, and its kernel session's person is him
  const b = await asBen("agents.ask", { agent: "kit", text: "hello", wait: false });
  assert.equal(b.error, undefined, JSON.stringify(b.error));
  const T = b.data.thread;
  assert.equal(row(T)?.account, benAcct.data.id, "his own account");
  assert.equal(row(T)?.opts.runas, BEN, "the thread acts as him (kept for every turn and resume)");
  const s = await until(() => seen.find(q => q.thread === T), "his thread's kernel session").catch(e => { throw new Error(`${e.message}; ${diag()}`); });
  assert.equal(s.runas, BEN, diag());
  assert.equal(s.person, BEN, `the session chain starts with the member: ${diag()}`);
  assert.notEqual(s.person, OWNER, "NEGATIVE: never the owner's chain");

  // B2: now that his thread acts as him, a helper from it is his call: a member's own session starts none (the registry's door keeps agents.spawn to the owner and admins), and nothing is recorded
  const before = subs();
  const benSpawn = await d.registry.call("agents.spawn", { task: "look it up", label: "reader" }, "mcp:agent:kit", { agent: "kit", thread: T, ...benTok });
  assert.equal(benSpawn.error && benSpawn.error.code, "denied", JSON.stringify(benSpawn));
  assert.equal(subs(), before, "NEGATIVE: no helper for the member, and never one on the owner's account");
  // an admin with no account of her own: refused by the handler in plain words, nothing recorded, never run on the owner's
  const refused = await d.registry.call("agents.spawn", { task: "look it up" }, "mcp:agent:kit", { agent: "kit", thread: T, ...adaTok });
  assert.match(String(refused.error && refused.error.message), /Connect your own AI account in Settings, AI accounts, to use kit\./, JSON.stringify(refused));
  assert.equal(subs(), before, "NEGATIVE: no helper was recorded or started for her");
  // with her own account: a helper from her own thread with the agent works for her, on her account, its kernel session hers
  const adaAcct = await d.registry.call("sessions.accounts.add", { provider: "claude", label: "Ada's Claude", kind: "login" }, "deck", adaTok);
  assert.equal(adaAcct.error, undefined, JSON.stringify(adaAcct.error));
  const a = await d.registry.call("agents.ask", { agent: "kit", text: "hello", wait: false }, "deck", adaTok);
  assert.equal(a.error, undefined, JSON.stringify(a.error));
  assert.notEqual(a.data.thread, T, "her own thread, not his");
  const h = await d.registry.call("agents.spawn", { task: "look it up", label: "reader" }, "mcp:agent:kit", { agent: "kit", thread: a.data.thread, ...adaTok });
  assert.equal(h.error, undefined, JSON.stringify(h.error));
  assert.equal(subs(), before + 1);
  assert.equal(row(h.data.thread)?.account, adaAcct.data.id, "the helper runs on her account");
  assert.equal(row(h.data.thread)?.opts.runas, ADA, "and acts as her");
  const hs = await until(() => seen.find(q => q.thread === h.data.thread), "the helper's kernel session").catch(e => { throw new Error(`${e.message}; ${diag()}`); });
  assert.equal(hs.person, ADA, `the helper's session is hers: ${diag()}`);

  // S2: the owner resuming his thread brings it back as him, on his account
  assert.ok(!(await asOwner("threads.stop", { thread: T })).error);
  await until(async () => (await asOwner("threads.get", { thread: T, limit: 1 })).data?.thread?.status === "stopped", "his thread to stop");
  const k0 = seen.length;
  const r = await asOwner("agents.resume", { agent: "kit", thread: T });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(row(T)?.account, benAcct.data.id, "resumed on his account");
  const again = await until(() => seen.slice(k0).find(q => q.thread === T), "the resumed thread's kernel session").catch(e => { throw new Error(`${e.message}; ${diag()}`); });
  assert.equal(again.person, BEN, `resumed as him: ${diag()}`);
  assert.equal(seen.filter(q => q.thread === T || q.thread === h.data.thread).filter(q => q.person === OWNER).length, 0, "NEGATIVE: no session of his ever ran as the owner");
});
