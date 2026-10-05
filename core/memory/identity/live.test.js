// @ts-check
// The identity home on a real daemon: the person's identity memory sealed on the space server. Root on that server reads the database file and the identity folder and finds ciphertext
// only; the person's assistant reads it after the person's phone says yes; the person's own server takes it over with nothing decrypted on the way.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../../daemon/index.js";
import { call } from "../../daemon/client.js";
import { tempHome } from "../../../test/helpers.js";
import { newDeviceKey } from "./crypto.js";
import { approveUnlock, IdentityHome, FileBackend } from "./home.js";
import { configureYes } from "../../../lib/one-yes.js";

const FACT = "I live in Lisbon and I use Postgres.";

/** Every byte a root user on this server could read: the whole home (database, log, identity folder), as text. */
function rootSees(dir) {
  const out = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/(^|\/)(sockets|transcripts)$/.test(p)) walk(p); } else { try { out.push(fs.readFileSync(p, "latin1")); } catch { /* a socket */ } } } };
  walk(dir);
  return out.join("\n");
}

async function world(t) {
  const root = fs.realpathSync(tempHome(t));
  const serverDir = path.join(root, "space-server-blobs");
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [path.join(root, "transcripts")], recall: { every: 0, vectors: false },
    memory: { identity: { id: "ident_alex", home: serverDir, name: "the Space's server" } } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  assert.ok(!(await call("agents.create", { name: "juno", kind: "assistant" }, { root })).error);
  assert.ok(!(await call("agents.create", { name: "kit", projects: [] }, { root })).error);
  const phone = newDeviceKey();
  // The person's phone says yes only over the exact request it was shown (a stand-in for the sealing process's proof check).
  /** @type {any[]} */ const shown = [];
  configureYes({ softwareOk: () => true, verify: async i => (i.proof && i.proof.signed === true && shown.some(s => s.request === i.fields.request && s.identity === i.fields.identity) && i.op === "memory.identity.unlock" ? null : "bad_signature") });
  t.after(() => configureYes({ verify: null }));
  const ask = (tool, input, caller = "cli") => d.registry.call(tool, input, caller);
  return { d, root, serverDir, phone, ask, shown };
}

test("the identity memory is sealed on the server: root finds only ciphertext, the tools say locked, the person's assistant reads it after the phone's yes, and the person's own server takes it over", async t => {
  const w = await world(t);
  const { ask, phone } = w;
  // The person tells memory something about themselves; it is a fact in their identity memory.
  assert.equal((await ask("memory.remember", { text: FACT })).error, undefined);
  assert.match(JSON.stringify((await ask("memory.profile", {})).data), /Lisbon/);
  assert.ok(rootSees(w.root).includes("Lisbon"), "before sealing the database holds it in the clear (that is what sealing is for)");

  // Seal it: ciphertext into the identity home, the rows out of the database.
  const sealed = await ask("memory.identity.enroll", { devices: [{ label: "phone", publicJwk: phone.publicJwk }], recovery_code: "four words and more" });
  assert.equal(sealed.error, undefined, JSON.stringify(sealed));
  assert.deepEqual([sealed.data.kept, sealed.data.unlocked, sealed.data.devices, sealed.data.recovery_code], ["here", false, 1, true]);
  // Root on the server (the database, its log, the identity folder, everything): nothing readable.
  const seen = rootSees(w.root);
  for (const s of ["Lisbon", "Postgres", "memory_me_told rows"]) assert.ok(!seen.includes(s), `${s} is readable on the server`);
  assert.ok(fs.existsSync(path.join(w.serverDir, "identity", "ident_alex", "manifest.json")));
  // Locked: nobody reads it, not the person at their surface, not the assistant.
  for (const [tool, caller] of [["memory.profile", "cli"], ["memory.profile", "mcp:agent:juno"], ["memory.me", "cli"]]) {
    const r = await ask(tool, {}, caller);
    assert.equal(r.error?.code, "denied", `${tool} as ${caller}: ${JSON.stringify(r).slice(0, 160)}`);
    assert.match(r.error.message, /identity memory is locked/);
  }
  // A project agent has no part in it at all.
  assert.equal((await ask("memory.identity.unlock.begin", {}, "mcp:agent:kit")).error?.code, "denied");
  assert.equal((await ask("memory.identity.enroll", { devices: [{ publicJwk: phone.publicJwk }] }, "mcp:agent:juno")).error?.code, "denied", "sealing is the person's own act");

  // The person's assistant asks; the phone shows the card, the person says yes with Face ID, and answers.
  const begun = await ask("memory.identity.unlock.begin", {}, "mcp:agent:juno");
  assert.equal(begun.error, undefined, JSON.stringify(begun));
  const answer = approveUnlock(phone, begun.data.ask);
  // No yes, or a yes over another request: refused, and the memory stays locked.
  assert.equal((await ask("memory.identity.unlock.finish", { request: begun.data.ask.request, answer, proof: {} }, "mcp:agent:juno")).error?.code, "denied");
  assert.equal((await ask("memory.identity.unlock.finish", { request: begun.data.ask.request, answer, proof: { signed: true } }, "mcp:agent:juno")).error?.code, "denied", "a yes nobody was shown this request for");
  assert.equal((await ask("memory.identity.status", {}, "mcp:agent:juno")).data.unlocked, false);
  w.shown.push({ request: begun.data.ask.request, identity: "ident_alex" });
  const done = await ask("memory.identity.unlock.finish", { request: begun.data.ask.request, answer, proof: { signed: true } }, "mcp:agent:juno");
  assert.equal(done.error, undefined, JSON.stringify(done));
  assert.equal(done.data.unlocked, true);
  assert.match(JSON.stringify((await ask("memory.profile", {}, "mcp:agent:juno")).data), /Lisbon/, "the assistant reads it");
  assert.equal((await ask("memory.profile", {}, "mcp:agent:kit")).error?.code, "denied", "an agent that is not the assistant still does not");
  // The request is one use.
  assert.equal((await ask("memory.identity.unlock.finish", { request: begun.data.ask.request, answer, proof: { signed: true } }, "mcp:agent:juno")).error?.code, "not_found");

  // The assistant learns something new while unlocked; locking saves it as ciphertext and takes the rows out again.
  assert.equal((await ask("memory.remember", { text: "I prefer short emails." })).error, undefined);
  const locked = await ask("memory.identity.lock", {}, "mcp:agent:juno");
  assert.equal(locked.data.unlocked, false);
  assert.ok(!rootSees(w.root).includes("Lisbon") && !rootSees(w.root).includes("short emails"), "locked again: nothing in the clear");

  // The person gets their own server (even a tiny one): the home moves there. Nothing is decrypted, and the same phone opens it.
  const own = path.join(w.root, "my-own-tiny-server");
  const moved = await ask("memory.identity.move", { to: own, name: "my server" });
  assert.equal(moved.error, undefined, JSON.stringify(moved));
  assert.equal(moved.data.to, "my server");
  assert.deepEqual(fs.readdirSync(path.join(w.serverDir, "identity", "ident_alex")), ["moved.json"], "the old server keeps only a marker");
  assert.ok(!rootSees(own).includes("Lisbon"));
  const again = await ask("memory.identity.unlock.begin", {}, "mcp:agent:juno");
  assert.equal(again.error, undefined, JSON.stringify(again));
  w.shown.push({ request: again.data.ask.request, identity: "ident_alex" });
  const back = await ask("memory.identity.unlock.finish", { request: again.data.ask.request, answer: approveUnlock(phone, again.data.ask), proof: { signed: true } }, "mcp:agent:juno");
  assert.equal(back.error, undefined, JSON.stringify(back));
  const profile = JSON.stringify((await ask("memory.profile", {}, "mcp:agent:juno")).data);
  assert.match(profile, /Lisbon/);
  assert.match(profile, /short emails/, "and what the assistant learned before the move came along");
});

test("a server without a sealed home behaves as it always did", async t => {
  const root = fs.realpathSync(tempHome(t));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [path.join(root, "t")], recall: { every: 0, vectors: false } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  assert.deepEqual((await d.registry.call("memory.identity.status", {}, "cli")).data, { kept: "none", unlocked: false, devices: 0, recovery_code: false });
  assert.equal((await d.registry.call("memory.identity.unlock.begin", {}, "cli")).error?.code, "not_found");
  assert.equal((await d.registry.call("memory.remember", { text: FACT }, "cli")).error, undefined);
  assert.match(JSON.stringify((await d.registry.call("memory.profile", {}, "cli")).data), /Lisbon/);
});
