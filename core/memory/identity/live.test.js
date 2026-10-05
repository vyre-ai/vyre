// @ts-check
// The identity home on a real daemon: the person's identity memory sealed on the space server. Root on that server reads the database file, its log and the identity folder and finds ciphertext
// only, even while the memory is unlocked, and after a kill; the person's assistant reads it after the person's one yes, with no re-asking; and the person's own server takes it over.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { call } from "../../daemon/client.js";
import { tempHome } from "../../../test/helpers.js";
import { newDeviceKey } from "../../../lib/keywrap.js";
import { Phone } from "./home.js";
import { relocate } from "./live.js";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../schema.js";
import { configureYes } from "../../../lib/one-yes.js";

const FACT = "I live in Lisbon and I use Postgres.";
const CLEAR = ["Lisbon", "Postgres", "short emails"];

/** Every byte a root user on this server could read from the disk: the whole home (database, its log, identity folder), as text. Not the process's memory. */
function rootSees(dir) {
  const out = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/(^|\/)(sockets|transcripts)$/.test(p)) walk(p); } else { try { out.push(fs.readFileSync(p, "latin1")); } catch { /* a socket */ } } } };
  walk(dir);
  return out.join("\n");
}
/** Which files hold a string, for a failure message. */
function whereIs(dir, needle) {
  const out = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { try { if (fs.readFileSync(p, "latin1").includes(needle)) out.push(path.relative(dir, p)); } catch { /* a socket */ } } } };
  walk(dir);
  return out;
}
const config = (root, serverDir) => fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [path.join(root, "transcripts")], recall: { every: 0, vectors: false },
  memory: { identity: { id: "ident_alex", home: serverDir, name: "the Space's server", autosave_ms: 150 } } }));

async function world(t, root = fs.realpathSync(tempHome(t))) {
  const serverDir = path.join(root, "space-server-blobs");
  config(root, serverDir);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop().catch?.(() => {}));
  if (!(await call("agents.list", {}, { root })).data?.some?.(a => a.name === "juno")) {
    assert.ok(!(await call("agents.create", { name: "juno", kind: "assistant" }, { root })).error);
    assert.ok(!(await call("agents.create", { name: "kit", projects: [] }, { root })).error);
  }
  const device = newDeviceKey();
  // The person's phone says yes only over the exact request it was shown (a stand-in for the sealing process's proof check).
  /** @type {any[]} */ const shown = [];
  configureYes({ softwareOk: () => true, verify: async i => (i.proof && i.proof.signed === true && i.op === "memory.identity.unlock" && shown.some(s => s.server === i.fields.server && s.identity === i.fields.identity) ? null : "bad_signature") });
  t.after(() => configureYes({ verify: null }));
  // The kernel is on: a call is a person's or an agent's by the facts the daemon proves, never by its label. The person at the cli is the home's owner on its own socket; an agent is a vouched session of
  // that person (the assistant acts as them; a project agent is its own actor).
  const factsOf = (/** @type {string} */ caller) => (caller === "cli" ? { kernelFacts: { kind: "socket", surface: "cli", uid: process.getuid ? process.getuid() : 0, pid: process.pid, inside_model_process: false, capsule_verified: true } }
    : /^mcp:agent:/.test(caller) ? { kernelFacts: { kind: "agent_session", agent: caller.split(":")[2], session: `s-${caller.split(":")[2]}`, thread: `t-${caller.split(":")[2]}`, vouched: true, person: d.kernel.id.owner } } : {});
  const ask = (tool, input, caller = "cli") => d.registry.call(tool, input, caller, factsOf(caller));
  const serverKey = () => JSON.parse(fs.readFileSync(path.join(root, "identity-server-key.json"), "utf8"));
  return { d, root, serverDir, device, ask, shown, serverKey };
}

test("the identity memory is sealed on the server: root finds only ciphertext (also while it is unlocked), the tools say locked, the person's one yes lets their assistant read it with no re-asking, and the person's own server takes it over", async t => {
  const w = await world(t);
  const { ask, device } = w;
  const phone = new Phone(device);
  assert.equal((await ask("memory.remember", { text: FACT })).error, undefined);
  assert.match(JSON.stringify((await ask("memory.profile", {})).data), /Lisbon/);
  assert.ok(rootSees(w.root).includes("Lisbon"), "before sealing the disk holds it in the clear (that is what sealing is for)");

  const sealed = await ask("memory.identity.enroll", { devices: [{ label: "phone", publicJwk: device.publicJwk }], recovery_code: "four words and more" });
  assert.equal(sealed.error, undefined, JSON.stringify(sealed));
  assert.deepEqual([sealed.data.kept, sealed.data.unlocked, sealed.data.devices, sealed.data.recovery_code], ["here", false, 1, true]);
  for (const s of CLEAR) assert.ok(!rootSees(w.root).includes(s), `${s} is readable on the server`);
  for (const [tool, caller] of [["memory.profile", "cli"], ["memory.profile", "mcp:agent:juno"], ["memory.me", "cli"]]) {
    const r = await ask(tool, {}, caller);
    assert.equal(r.error?.code, "denied", `${tool} as ${caller}: ${JSON.stringify(r).slice(0, 160)}`);
    assert.match(r.error.message, /identity memory is locked/);
  }
  assert.equal((await ask("memory.identity.unlock.begin", {}, "mcp:agent:kit")).error?.code, "denied", "a project agent has no part in it");
  assert.equal((await ask("memory.identity.enroll", { devices: [{ publicJwk: device.publicJwk }] }, "mcp:agent:juno")).error?.code, "denied", "sealing is the person's own act");

  // The person's one yes for this server. Without it, or over some other request, nothing is granted.
  const fp = (await ask("memory.identity.status", {}, "mcp:agent:juno")).data.server;
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal((await ask("memory.identity.grant", { proof: {} }, "mcp:agent:juno")).error?.code, "denied");
  assert.equal((await ask("memory.identity.grant", { proof: { signed: true } }, "mcp:agent:juno")).error?.code, "denied", "a yes nobody was shown this for");
  const early = await ask("memory.identity.unlock.begin", {}, "mcp:agent:juno");
  assert.equal(early.error, undefined);
  assert.throws(() => phone.answer(early.data.ask), { code: "needs_yes" }, "the phone does not answer a server it was not granted");
  assert.equal((await ask("memory.identity.unlock.finish", { request: early.data.ask.request, answer: {} }, "mcp:agent:juno")).error?.code, "denied", "and the server takes no answer without the grant");
  w.shown.push({ server: fp, identity: "ident_alex" });
  const granted = await ask("memory.identity.grant", { proof: { signed: true } }, "mcp:agent:juno");
  assert.equal(granted.error, undefined, JSON.stringify(granted));
  assert.deepEqual(granted.data.granted.map(g => g.fp), [fp]);
  phone.grant(w.serverKey().publicJwk);

  // From here the assistant unlocks with no prompt: ask, the phone answers by itself, finish.
  const unlock = async () => { const b = await ask("memory.identity.unlock.begin", {}, "mcp:agent:juno"); assert.equal(b.error, undefined, JSON.stringify(b)); return ask("memory.identity.unlock.finish", { request: b.data.ask.request, answer: phone.answer(b.data.ask) }, "mcp:agent:juno"); };
  const done = await unlock();
  assert.equal(done.error, undefined, JSON.stringify(done));
  assert.equal(done.data.unlocked, true);
  assert.match(JSON.stringify((await ask("memory.profile", {}, "mcp:agent:juno")).data), /Lisbon/, "the assistant reads it");
  assert.equal((await ask("memory.profile", {}, "mcp:agent:kit")).error?.code, "denied", "an agent that is not the assistant still does not");
  const used = await ask("memory.identity.unlock.begin", {}, "mcp:agent:juno");
  assert.equal((await ask("memory.identity.unlock.finish", { request: used.data.ask.request, answer: phone.answer(used.data.ask) }, "mcp:agent:juno")).error, undefined);
  assert.equal((await ask("memory.identity.unlock.finish", { request: used.data.ask.request, answer: phone.answer(used.data.ask) }, "mcp:agent:juno")).error?.code, "not_found", "a request is one use");

  // While it is unlocked the facts are in the process only: a new one reaches the disk as ciphertext, and root still finds nothing.
  assert.equal((await ask("memory.remember", { text: "I prefer short emails." })).error, undefined);
  const rev = (await ask("memory.identity.status", {}, "mcp:agent:juno")).data.rev;
  for (let i = 0; i < 60 && (await ask("memory.identity.status", {}, "mcp:agent:juno")).data.rev === rev; i++) await new Promise(r => setTimeout(r, 100));
  assert.ok((await ask("memory.identity.status", {}, "mcp:agent:juno")).data.rev > rev, "the new fact was sealed within the autosave");
  for (const s of CLEAR) assert.ok(!rootSees(w.root).includes(s), `${s} is on the disk while unlocked (in ${whereIs(w.root, s).join(", ")})`);

  // Revoked from the phone: locked now, and the phone and the server both refuse after.
  const revoked = await ask("memory.identity.revoke", {}, "cli");
  assert.equal(revoked.error, undefined, JSON.stringify(revoked));
  assert.deepEqual([revoked.data.unlocked, revoked.data.granted], [false, []]);
  assert.equal((await ask("memory.profile", {}, "mcp:agent:juno")).error?.code, "denied");
  const after = await ask("memory.identity.unlock.begin", {}, "mcp:agent:juno");
  assert.equal((await ask("memory.identity.unlock.finish", { request: after.data.ask.request, answer: phone.answer(after.data.ask) }, "mcp:agent:juno")).error?.code, "denied", "no grant, no unlock, even if a phone still answered");
  assert.equal((await ask("memory.identity.revoke", {}, "mcp:agent:juno")).error?.code, "denied", "revoking is the person's own act");

  // Grant again, then the person gets their own server (even a tiny one): the home moves there, nothing decrypted, and the same phone opens it.
  assert.equal((await ask("memory.identity.grant", { proof: { signed: true } }, "mcp:agent:juno")).error, undefined);
  const own = path.join(w.root, "my-own-tiny-server");
  const moved = await ask("memory.identity.move", { to: own, name: "my server" });
  assert.equal(moved.error, undefined, JSON.stringify(moved));
  assert.deepEqual(fs.readdirSync(path.join(w.serverDir, "identity", "ident_alex")), ["moved.json"], "the old server keeps only a marker");
  for (const s of CLEAR) assert.ok(!rootSees(own).includes(s));
  assert.equal((await unlock()).error, undefined);
  const profile = JSON.stringify((await ask("memory.profile", {}, "mcp:agent:juno")).data);
  assert.match(profile, /Lisbon/);
  assert.match(profile, /short emails/, "and what the assistant learned came along");
});

test("a restart is answered from the phone without asking again, while the grant stands, and the disk never held the facts in the clear", async t => {
  const root = fs.realpathSync(tempHome(t));
  const w = await world(t, root);
  const phone = new Phone(w.device);
  await w.ask("memory.remember", { text: FACT });
  await w.ask("memory.identity.enroll", { devices: [{ publicJwk: w.device.publicJwk }] });
  const fp = (await w.ask("memory.identity.status", {}, "mcp:agent:juno")).data.server;
  w.shown.push({ server: fp, identity: "ident_alex" });
  assert.equal((await w.ask("memory.identity.grant", { proof: { signed: true } }, "mcp:agent:juno")).error, undefined);
  phone.grant(w.serverKey().publicJwk);
  await w.d.stop();
  // The server comes back: locked, and it tells the phone it wants the memory (an event); the phone calls begin, answers, finish: no prompt, no yes.
  const d2 = await start({ root, log: () => {} });
  t.after(() => d2.stop());
  const asked = d2.registry.deps.db.prepare("SELECT payload FROM events WHERE type = 'memory.unlock-asked'").all();
  assert.ok(asked.length >= 1, "the phone was told");
  assert.equal((await d2.registry.call("memory.identity.status", {}, "mcp:agent:juno")).data.unlocked, false);
  const b = await d2.registry.call("memory.identity.unlock.begin", {}, "mcp:agent:juno");
  const f = await d2.registry.call("memory.identity.unlock.finish", { request: b.data.ask.request, answer: phone.answer(b.data.ask) }, "mcp:agent:juno");
  assert.equal(f.error, undefined, JSON.stringify(f));
  assert.match(JSON.stringify((await d2.registry.call("memory.profile", {}, "mcp:agent:juno")).data), /Lisbon/);
});

test("killed while unlocked, the disk holds ciphertext only, and nothing sealed is lost", async t => {
  const root = fs.realpathSync(tempHome(t));
  const serverDir = path.join(root, "space-server-blobs");
  config(root, serverDir);
  const device = newDeviceKey();
  const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "crash-child.mjs"), root], { env: { ...process.env, CHILD_PHONE: JSON.stringify(device) }, stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((resolve, reject) => { let buf = ""; child.stdout.on("data", c => { buf += c; if (buf.includes("READY")) resolve(undefined); }); child.on("exit", code => reject(new Error(`the child ended (${code}) before it was ready`))); setTimeout(() => reject(new Error("the child was not ready in time")), 60_000); });
  child.removeAllListeners("exit");
  child.kill("SIGKILL");                                                              // no stop, no lock, nothing flushed by the process itself
  await new Promise(r => child.on("exit", r));
  for (const s of CLEAR) assert.ok(!rootSees(root).includes(s), `${s} is on the disk after a kill`);
  // What was sealed is all still there: a new server unlocks it from the phone and has both facts.
  const w = await world(t, root);
  const phone = new Phone(device);
  phone.grant(w.serverKey().publicJwk);
  const b = await w.ask("memory.identity.unlock.begin", {}, "mcp:agent:juno");
  assert.equal((await w.ask("memory.identity.unlock.finish", { request: b.data.ask.request, answer: phone.answer(b.data.ask) }, "mcp:agent:juno")).error, undefined);
  const profile = JSON.stringify((await w.ask("memory.profile", {}, "mcp:agent:juno")).data);
  assert.match(profile, /Lisbon/);
  assert.match(profile, /short emails/);
});

test("a server without a sealed home behaves as it always did", async t => {
  const root = fs.realpathSync(tempHome(t));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [path.join(root, "t")], recall: { every: 0, vectors: false } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  assert.deepEqual((await d.registry.call("memory.identity.status", {}, "cli")).data, { kept: "none", unlocked: false, devices: 0, recovery_code: false, granted: [], server: null });
  assert.equal((await d.registry.call("memory.identity.unlock.begin", {}, "cli")).error?.code, "not_found");
  assert.equal((await d.registry.call("memory.remember", { text: FACT }, "cli")).error, undefined);
  assert.match(JSON.stringify((await d.registry.call("memory.profile", {}, "cli")).data), /Lisbon/);
});

test("while the identity memory is open SQLite keeps its temporary storage in memory too, so a sort or a temporary table never spills a fact to a file", async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "vyre-temp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(dir, "vyre.db"));
  db.exec("CREATE TABLE _migrations (id INTEGER PRIMARY KEY)");
  for (const m of MIGRATIONS) db.exec(m);
  assert.equal(db.prepare("PRAGMA temp_store").get().temp_store, 0, "by default SQLite may use a file");
  relocate(db);
  assert.equal(db.prepare("PRAGMA temp_store").get().temp_store, 2, "MEMORY once the identity tables live in memory");
  db.close();
});
