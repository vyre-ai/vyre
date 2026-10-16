// @ts-check
// Shared test helpers. Every test gets its own VYRE_HOME in a temp folder; nothing ever touches
// the real ~/.vyre. A past prototype test read live state and printed a real key into a failure
// message, which is why this is the only way tests get a home.

import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { SCRATCH, HOMES } from "./scratch.mjs";
import { setPeerHosting } from "../core/daemon/peer.js";

// A test starts vyred in its own process and runs the person's client as that process or its child.
// vyred counts a caller as the person on positive proof only, and a descendant of vyred is a model's
// in production (core/daemon/peer.js insideClaude); this lets the tests' own clients through. The
// forger tests unset it, so they prove the production rule.
process.env.VYRE_TEST_HOSTED = "1"; // for a vyred a test starts as a child (see peerHosting)
setPeerHosting(true);

// A person's first name is finished with a reservation code from vyre.run/setup (spaces.identity.create). The walks and tests that make many people let the home reserve each name itself, a development
// build's switch (never honoured in a release build); the tests of the code path itself unset it.
if (process.env.VYRE_TEST_SELF_RESERVE === undefined) process.env.VYRE_TEST_SELF_RESERVE = "1";

// A ring ticket (relay.pair.ticket) is confirmed with three words by the Wink module once that module is up (X-1, 4 Oct 2026): the redeemer is a waiting pairing until the
// person picks the right words. Tests of the relay's own pairing run with no one to confirm, so they take the one-step ring; test/wink.test.js unsets this and tests the gate.
if (process.env.VYRE_TEST_UNGATED_RING === undefined) process.env.VYRE_TEST_UNGATED_RING = "1";

// No test may run the machine's real tailscale: `vyre up` on a Mac with no box looks for one on
// the tailnet (ADR 0008). A path that does not exist reads as "Tailscale is not installed". A test
// that needs Tailscale sets its own fake, which replaces this.
if (!process.env.VYRE_TAILSCALE_BIN) process.env.VYRE_TAILSCALE_BIN = path.join(os.tmpdir(), "vyre-no-tailscale", "tailscale");

/**
 * @param {any} t
 * @param {{ stop?: () => (Promise<any>|any) }} [opts] `stop`: for a test that runs vyred
 *   in-process (`start()` from core/daemon/index.js, not a spawned `vyre up`), a callback that
 *   stops it. stopDaemon() below only knows how to stop a *spawned* vyred (it reads vyred.pid and
 *   signals it; an in-process one has no pid of its own to signal). Without `stop`, an in-process
 *   daemon a test registers its own later `t.after(() => d.stop())` for is stopped too late:
 *   after-hooks run in the order they were added (this one, tempHome's own, always runs first,
 *   for the same reason stopDaemon exists at all), so the directory below is removed while that
 *   daemon - and any live child it started - is still writing into it. ENOTEMPTY on rmSync,
 *   found under the full suite at concurrency 4 (2026-09-28): ostensibly a leftover-file race,
 *   actually a daemon that was never given the chance to stop first. Pass `stop` and it runs
 *   before stopDaemon and the rmSync below, in the one place guaranteed to run first.
 */
export function tempHome(t, { stop } = {}) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-test-"));
  // A leaked home can come back holding only what a late write put there, so the name of the
  // test that made it is kept outside it.
  const name = /** @type {any} */ (t).fullName || t.name;
  try { fs.appendFileSync(HOMES, `${path.basename(dir)}\t${path.relative(path.resolve(import.meta.dirname, ".."), process.argv[1] || "?")}\t${name}\n`); } catch {}
  const real = path.join(os.homedir(), ".vyre");
  if (path.resolve(dir) === path.resolve(real)) throw new Error("a test tried to use the real ~/.vyre");
  const prev = process.env.VYRE_HOME;
  process.env.VYRE_HOME = dir;
  // No test reaches the user's real Tailscale: unless a test set its own fake, point the binary at
  // a path that does not exist, which every caller treats as "no tailnet". Child processes a test
  // spawns inherit it.
  const prevTs = process.env.VYRE_TAILSCALE_BIN;
  if (!prevTs) process.env.VYRE_TAILSCALE_BIN = path.join(dir, "no-tailscale");
  t.after(async () => {
    if (prev === undefined) delete process.env.VYRE_HOME; else process.env.VYRE_HOME = prev;
    if (prevTs === undefined) delete process.env.VYRE_TAILSCALE_BIN; else process.env.VYRE_TAILSCALE_BIN = prevTs;
    // A test that ran `vyre up` in a child process may still have that vyred running: after-hooks
    // run in the order they were added, so this cleanup runs before the test's own `vyre down`.
    // Deleting the home under a live vyred orphaned it (fourteen of them, found running). So stop
    // any daemon this home started, unless it is this process (an in-process start()).
    if (stop) await Promise.resolve(stop()).catch(e => console.error(`test helpers: tempHome's stop() failed (${dir}): ${e.message}`));
    await stopDaemon(dir);
    // Retried: on a busy hosted runner a late write from a just-stopped child (a fake binary's log) can land while the
    // folder is being removed, which is ENOTEMPTY (files.drive.search, stage run 36772688407); a second pass removes it.
    removeHome(dir);
  });
  return dir;
}

/**
 * Remove a temp home, retrying; if it still will not go, say what is left in it (names only, never contents), so a
 * recurring ENOTEMPTY names the late writer and the cause can be fixed instead of retried forever.
 * @param {string} dir
 */
export function removeHome(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  catch (e) {
    const left = [];
    const walk = (d, depth = 0) => {
      let names = [];
      try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const n of names) {
        if (left.length >= 40) return;
        left.push(path.relative(dir, path.join(d, n.name)) + (n.isDirectory() ? "/" : ""));
        if (n.isDirectory() && depth < 3) walk(path.join(d, n.name), depth + 1);
      }
    };
    walk(dir);
    throw Object.assign(new Error(`${/** @type {Error} */ (e).message}; left in ${path.basename(dir)}: ${left.join(", ") || "(nothing now)"}`), { code: /** @type {any} */ (e).code });
  }
}

/**
 * Stop a vyred child process started in this home, and wait for it to actually be gone before
 * returning: a caller that removes the home right after this resolves (as every one does) must
 * never do it out from under a process still holding it open, the same class of bug that once
 * orphaned fourteen running vyreds when their homes were deleted out from under them.
 */
export async function stopDaemon(dir) {
  let pid = 0;
  try { pid = Number(fs.readFileSync(path.join(dir, "vyred.pid"), "utf8")); } catch { return; }
  if (!pid || pid === process.pid) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(r => setTimeout(r, 50));
  }
  // SIGTERM alone did not make it exit within 2.5s (a held-open SSE stream or a stuck signal
  // handler can do this). Force it, but say so loudly: a silent SIGKILL here would paper over a
  // real hang instead of surfacing it, the same class of bug that used to hang this whole suite.
  console.error(`test helpers: vyred pid ${pid} did not exit on SIGTERM within 2.5s, sending SIGKILL`);
  try { process.kill(pid, "SIGKILL"); } catch { return; }
  for (let i = 0; i < 20; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(r => setTimeout(r, 50));
  }
  console.error(`test helpers: vyred pid ${pid} still alive 1s after SIGKILL; the home will not be removed`);
  throw new Error(`vyred pid ${pid} would not die; not removing its home`);
}

/** The pids of the children of this test process, now. */
const childrenNow = () => { try { return execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number); } catch { return []; /* none, or no pgrep */ } };

/**
 * Stop an in-process daemon at the end of a test so that a failing test cannot hold the file open: d.stop() within 20 s, then end every child that appeared under this test process AFTER this call
 * (a fake session the daemon started and did not wait for) and say so. Children that already ran when the helper was called (a sealing process the daemon started with itself, a server the file made
 * before) are not touched: the daemon's own stop owns those. A child the file starts later and means to keep passes in `keep` as a function of its pid. It hides nothing: a daemon that would not stop, or
 * a child left behind, fails the test, with the pid. Use it as `stopDaemonBounded(t, d)` right after start().
 * `before` is the set of children there were before the daemon started (startDaemonBounded passes it, so what start() itself launched is checked too).
 * @param {any} t @param {{ stop: () => Promise<any> }} d @param {{ keep?: (pid: number) => boolean, before?: Set<number> }} [o]
 */
export function stopDaemonBounded(t, d, o = {}) {
  const before = o.before || new Set(childrenNow());
  t.after(async () => {
    /** @type {any} */ let timer, failure = null; /** @type {number[]} */ let left = [];
    try { await Promise.race([d.stop(), new Promise((_, no) => { timer = setTimeout(() => no(new Error("the daemon did not stop in 20 s")), 20_000); })]); }
    catch (e) { failure = e; }
    finally {
      clearTimeout(timer);
      const pids = childrenNow().filter(pid => !before.has(pid) && !(o.keep && o.keep(pid)));
      for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
      left = pids;
    }
    if (failure) throw failure;
    if (left.length) throw new Error(`the daemon stopped but left ${left.length} child process(es) running (pid ${left.join(", ")}), ended now`);
  });
}

/**
 * Start a daemon for a test (core/daemon start, the same options) and register its bounded stop: the children that exist BEFORE it starts are recorded first, so a sealing process or anything else
 * start() launches is checked at the end too. Use it where a test would write `const d = await start(opts); t.after(() => d.stop());`.
 * @param {any} t @param {any} opts @param {{ keep?: (pid: number) => boolean }} [o]
 */
export async function startDaemonBounded(t, opts, o = {}) {
  const before = new Set(childrenNow());
  const { start } = await import("../core/daemon/index.js");
  const d = await start(opts);
  stopDaemonBounded(t, d, { ...o, before });
  return d;
}

/**
 * One teardown for several daemons started in the same test (each with its own home). Several
 * `startDaemonBounded` hooks in one test blame later daemons' children on an earlier stop; this
 * stops every daemon in reverse start order and checks children once against the snapshot taken here.
 * @param {any} t @param {() => Array<{ stop: () => Promise<any> }>} daemons
 */
export function stopDaemonsBounded(t, daemons) {
  const beforeAll = new Set(childrenNow());
  t.after(async () => {
    /** @type {any} */ let failure = null;
    for (const d of [...daemons()].reverse()) {
      /** @type {any} */ let timer;
      try { await Promise.race([d.stop(), new Promise((_, no) => { timer = setTimeout(() => no(new Error("the daemon did not stop in 20 s")), 20_000); })]); }
      catch (e) { failure = e; }
      finally { clearTimeout(timer); }
      if (failure) break;
    }
    /** @type {number[]} */ let left = [];
    const pids = childrenNow().filter(pid => !beforeAll.has(pid));
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    left = pids;
    if (failure) throw failure;
    if (left.length) throw new Error(`the daemon stopped but left ${left.length} child process(es) running (pid ${left.join(", ")}), ended now`);
  });
}

/** Write a module folder under root with the given manifest and entry source. */
export function writeModule(root, name, manifest, source) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "module.json"), JSON.stringify({ name, version: "0.1.0", ...manifest }));
  fs.writeFileSync(path.join(dir, "index.js"), source);
  return dir;
}

/**
 * A presence verifier that finds a person at every call, for tests of what a tool does once the
 * user has approved. The presence tests themselves (core/presence, test/daemon.test.js,
 * test/presence-bypass.test.js) use the real one.
 */
export const present = {
  required: () => false,
  verify: async () => ({ ok: true, method: "test" }),
  // The daemon asks the real verifier for the Capsule's pin when it cannot classify a caller (a call from an ssh session with no terminal); a fixture pins nothing.
  capsulePin: () => null,
  challenge: async () => ({ error: { code: "bad_input", message: "presence is not checked in this test" } }),
};

/**
 * A presence verifier that finds NO person at any call, for tests that a denied proof stops a tool that declares presence: every presence-guarded tool answers
 * `presence_required` and nothing it would have done happens. Pass it as `start({ root, presence: absent })`. Tools that declare no presence are unaffected.
 */
export const absent = {
  required: (/** @type {string} */ _tool, /** @type {any} */ def) => Boolean(def && def.presence),
  verify: async () => ({ ok: false, code: "presence_required", message: "no person is here to approve this", methods: [] }),
  challenge: async () => ({ error: { code: "presence_required", message: "no person is here to approve this" } }),
};

/**
 * Start vyred in a child process for a temp home, as `vyre up` would, but with `present` as its
 * verifier. `vyre down` stops it as usual.
 * @param {string} home
 */
export async function upPresent(home) { return upFixture(home, "vyred-present.js"); }

/**
 * Start vyred in a child process for a temp home with the REAL verifier, except that it trusts the
 * terminal server this test runs under (over ssh on the testbox, the root sshd vyred cannot read,
 * which otherwise asks for one presence proof no headless test can give). Refusals still come
 * from the real verifier. `vyre down` stops it as usual.
 * @param {string} home @param {Record<string, string|undefined>} [env]
 */
export async function upLeader(home, env) { return upFixture(home, "vyred-leader.js", env); }

/** @param {string} home @param {string} fixture @param {Record<string, string|undefined>} [env] */
async function upFixture(home, fixture, env = process.env) {
  const { spawn } = await import("node:child_process");
  const { ping } = await import("../core/daemon/index.js");
  const config = await import("../core/config/index.js");
  const p = config.ensure(home);
  const fd = fs.openSync(path.join(p.logs, "vyred.out"), "a");
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "fixtures", fixture)],
    { detached: true, stdio: ["ignore", fd, fd], env: { ...env, VYRE_HOME: home } });
  child.unref();
  // A vyred takes about 10 seconds to open its socket on the shared test box (more under load), so the wait is 30 seconds, not a guess that fails half the time.
  for (let i = 0; i < 300; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (await ping(p.socket)) return { code: 0, pid: child.pid };
    if (child.exitCode !== null) break;
  }
  return { code: 1 };
}

/**
 * Calls as the Space owner's own enrolled device, with the kernel's development stand-in proof: what a paired app sends. Granting a project to an agent is a kernel grant (lib/project-reach.js), a
 * person's act with the kernel's own proof, so a test that makes an agent with `projects` makes it through this and not through the plain HTTP client. The stand-in needs the file
 * `dev-presence-stand-in` in the home (a development build reads it).
 * @param {any} d a started daemon @param {string} root its home @param {string} [caller]
 * @returns {(tool: string, input?: any) => Promise<any>}
 */
/**
 * A test daemon whose plain registry calls from a person's local surfaces (cli, deck, local, capsule) arrive as the owner's own enrolled device, as they do through the real socket (the daemon sets the
 * kernel facts of a surface it verified). A call with no person chain on a run in a chat is refused (core/switchboard chatGate fails closed), so a kernel-on test that calls threads.* as "cli" with
 * no meta uses this once after `start`. Calls that already carry a token, facts or a caller of another class are untouched.
 * @param {any} d @param {string} root @returns {any} d
 */
export function asOwner(d, root) {
  const meta = (() => { kernelCaller(d, root); return { proof: { method: "stand-in" }, kernel_proof: { method: "stand-in" }, kernelFacts: { kind: "device", device_key_id: "dphonepaired00001", person: d.kernel.id.owner, path: "relay", session: "ps_1" } }; })();
  const orig = d.registry.call.bind(d.registry);
  d.registry.call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller, /** @type {any} */ m) => {
    const person = /^(cli|deck|local|capsule)$/.test(String(caller));
    // a call whose only meta is an idempotency key still arrives as the owner's device; any other meta (an explicit {} for "no facts") is the test's own and is kept
    const keyOnly = m && typeof m === "object" && Object.keys(m).length === 1 && typeof m.idempotencyKey === "string";
    return orig(tool, input, caller, m === undefined ? (person ? meta : undefined) : person && keyOnly ? { ...meta, ...m } : m);
  };
  return d;
}

export function kernelCaller(d, root, caller = "cli") {
  fs.writeFileSync(path.join(root, "dev-presence-stand-in"), "walk\n");
  try { d.registry.deps.db.prepare("INSERT OR IGNORE INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, ?, 'p', 1, 'app', 0, NULL)").run("dphonepaired00001", "phone"); } catch { /* no relay table in this home: the call carries its facts anyway */ }
  const meta = { proof: { method: "stand-in" }, kernel_proof: { method: "stand-in" }, kernelFacts: { kind: "device", device_key_id: "dphonepaired00001", person: d.kernel.id.owner, path: "relay", session: "ps_1" } };
  return (tool, input = {}) => d.registry.call(tool, input, caller, meta);
}

/**
 * Put an agent on a project's team with a ready task there, as a Flow or a template does (G22: an agent reaches a project and its records only as a teammate with a task). A real daemon with the kernel on.
 * @param {any} d the started daemon @param {string} root its home @param {string} agent the agent's name @param {string} project the project's short name @param {{ grant?: boolean }} [o] `grant: false` puts the agent on the team with a task and makes no grant (a test of the grant itself)
 */
export async function putOnTask(d, root, agent, project, { grant = true } = {}) {
  const kcall = kernelCaller(d, root);
  let ref = await kcall("work.project.ref", { project });
  // the Project record follows projects.create a moment later: ask again for up to ten seconds before calling it missing
  for (let i = 0; ref.error && ref.error.code === "not_found" && i < 100; i++) { await new Promise(r => setTimeout(r, 100)); ref = await kcall("work.project.ref", { project }); }
  if (ref.error) throw new Error(`putOnTask: ${ref.error.message}`);
  const owner = d.kernel.id.owner, space = d.kernel.id.space;
  // the kernel knows an agent by its uid (agents.uid), not its name
  const u = await d.registry.call("agents.uid", { name: agent }, "module:projects");
  if (u.error || !u.data || !u.data.uid) throw new Error(`putOnTask: no agent ${agent}`);
  const uid = String(u.data.uid);
  const chain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-put-on-task", person: owner, path: "direct", session: "s" });
  try { await d.kernel.gateway.grants.addActor(chain, { kind: "agent", id: uid, space }, { presence: { method: "stand-in" } }); } catch (e) { if (!/exist|conflict|duplicate/i.test(String(e && (e.code || e.message)))) throw e; }   // the kernel knows the agent as an actor of the Space (already: nothing changes)
  if (grant) await kcall("projects.access.grant", { project, agent });   // the agent holds reach on the project (already: nothing changes); G22 adds the team row and the task below
  await d.kernel.gateway.records.create(chain, "team-member", { name: agent, actor: { actor: { kind: "agent", id: uid, space } }, kind: "assistant", project: { urn: ref.data.urn } });
  const t = await kcall("tasks.request", { task: { title: `Work for ${project}`, output: { kind: "note" }, doer: uid, checker: owner, project: ref.data.urn } });
  if (t.error) throw new Error(`putOnTask: ${t.error.message}`);
}

/**
 * Pair a device the way a real install does, so the daemon computes the person's facts for its calls (core/daemon/index.js callerFacts): the relay's row (an app device, not removed) and Wink's record of who
 * confirmed it. `identity` is the person the device belongs to: the owner's id for the owner's phone, a member's for theirs. A rig that calls the route as `device:<id>` without this has no device row, which no
 * real owner device lacks.
 * @param {any} d the started daemon @param {string} id the device id (the part after "device:") @param {string} identity
 */
export function pairDevice(d, id, identity) {
  const db = d.registry.deps.db;
  db.prepare("INSERT OR REPLACE INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, 'phone', 'p', 1, 'app', 0, NULL)").run(id);
  db.prepare("INSERT OR REPLACE INTO wink_devices (id, identity, kind, name, owner_kind, owner_id, created, confirmed_by) VALUES (?, ?, 'phone', 'phone', 'identity', ?, 1, ?)").run(id, identity, identity, identity);
}

/**
 * The Wink record a real install has for the OWNER's own paired device (adoption, or the three words): the device a rig paired through the relay is named as the home's owner, confirmed by the owner. The relay's own row
 * is left as the pairing made it. For a rig that stands for the owner's first device AFTER adoption; a rig for a path that leaves the device nameless must not call it.
 * @param {any} d the started daemon @param {string} id the device id (the part after "device:")
 */
export function nameAsOwner(d, id) {
  const identity = d.kernel.id.owner;
  d.registry.deps.db.prepare("INSERT OR REPLACE INTO wink_devices (id, identity, kind, name, owner_kind, owner_id, created, confirmed_by) VALUES (?, ?, 'phone', 'phone', 'identity', ?, 1, ?)").run(id, identity, identity, identity);
}

/**
 * A pairing URL a test device can redeem, standing in for the classic bearer code (`relay.pair.start`, removed 13 Oct 2026). It mints a ring ticket (`relay.pair.ticket`), which the test switch
 * `VYRE_TEST_UNGATED_RING` (set at the top of this file, never honoured in a packaged daemon) takes in one step like the confirmed ring, resolves it at the relay the way a phone does, and writes the
 * result in the old offer shape, so a test's existing `phone(url)` / `pairOffer(parsePairUrl(url))` redeems it unchanged. The device it pairs is the owner's own (a ring ticket is), which is what the
 * real approved paths make.
 * @param {any} d the running vyred
 * @param {string} [caller] @param {any} [meta] what the test passes as the call's proof
 * @returns {Promise<string>}
 */
export async function offerUrl(d, caller = "cli", meta = { proof: { method: "passkey", id: "x" } }) {
  const { resolveTicket } = await import("../relay/client/client.js");
  const { nodeCrypto } = await import("../relay/client/nodecrypto.js");
  const { fromBase64url } = await import("../relay/client/bytes.js");
  const { pairUrl } = await import("../core/relay/pairing.js");
  const minted = await d.registry.call("relay.pair.ticket", {}, caller, meta);
  if (!minted.data) throw new Error(`relay.pair.ticket: ${JSON.stringify(minted.error)}`);
  const status = (await d.registry.call("relay.status", {}, caller, meta)).data;
  const r = await resolveTicket(fromBase64url(minted.data.ticket), { relay: status.url, crypto: nodeCrypto() });
  return pairUrl({ relay: r.offer.relay, route: r.offer.route, box: Buffer.from(r.offer.box), secret: r.offer.secret, name: r.name });
}

/**
 * A real mail connection for a test that runs a whole vyred: a fake IMAP and SMTP server (core/mail/testing/fake-imap.js), the connection made through the Vault the way a person makes it, and its use opened
 * to agents. `cli(tool, input)` is the owner's call. Returns { mailbox, item, id }: the fake server (`mailbox.sent` lists what reached it), the vault item and the mail account id the `mail:<id>` sender is
 * named by. Used by core/gate/standing-mail.test.js; core/appmods/docuseal-live.test.js builds the same by hand.
 * @param {import("node:test").TestContext} t @param {(tool: string, input?: any) => Promise<any>} cli
 */
export async function mailFixture(t, cli, { user = "alex@harlow.example", password = "hunter2-hunter2" } = {}) {
  const { startFakeMail } = await import("../core/mail/testing/fake-imap.js");
  const mailbox = await startFakeMail(t, { user, password });
  const fields = (/** @type {string} */ security) => ({ imap_host: "127.0.0.1", imap_port: String(mailbox.imap.port), smtp_host: "127.0.0.1", smtp_port: String(mailbox.smtp.port), username: user, password, from: user, security });
  const conn = await cli("vault.connect", { module: "mail", need: "imap", label: "alex", fields: fields("tls") });
  if (!conn.data || !conn.data.item) throw new Error(`the mail connection was not made: ${JSON.stringify(conn.error || conn)}`);
  await cli("vault.put", { name: conn.data.item, kind: "env-set", fields: fields("none") });
  const accounts = await cli("mail.accounts", {});
  const rows = accounts.data && (Array.isArray(accounts.data) ? accounts.data : accounts.data.accounts) || [];
  const id = String((rows[0] && (rows[0].id || rows[0].account)) || conn.data.id || "");
  if (!id) throw new Error(`no mail account id: ${JSON.stringify(accounts)}`);
  await cli("vault.connections.grant", { id, surface: "agents" });
  return { mailbox, item: String(conn.data.item), id };
}
