// @ts-check
// Shared vaults as people use them: three real vyreds in temp homes. Alex owns "team" and is its
// home; Dana and Sam join by invite. Both write, both edit the same item (a conflict), Dana is
// removed, the key changes, everything she could read is flagged, and her copy goes. No value
// shows up in plain text anywhere on any of the three disks, or in what vyred says.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { request } from "../core/daemon/client.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "vyre");
const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const sha = v => crypto.createHash("sha256").update(v).digest("hex");

function vyre(home, args, input) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: home, NO_COLOR: "1" } });
    let out = "", err = "";
    p.stdout.on("data", c => { out += c; });
    p.stderr.on("data", c => { err += c; });
    p.on("close", code => resolve({ code, out, err, all: out + err }));
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}

function home(t, config) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-test-"));
  if (path.resolve(h) === path.resolve(os.homedir(), ".vyre")) throw new Error("a test tried to use the real ~/.vyre");
  fs.writeFileSync(path.join(h, "config.json"), JSON.stringify(config));
  t.after(async () => { await vyre(h, ["down"]); fs.rmSync(h, { recursive: true, force: true }); });
  return h;
}

/** `vyre call` a tool; returns its data or throws with its error. */
async function call(h, tool, input) {
  const r = await vyre(h, ["call", tool, JSON.stringify(input)]);
  let parsed;
  try { parsed = JSON.parse(r.out); } catch { throw new Error(`${tool}: ${r.all}`); }
  return parsed;
}

/** What `vyre vault run` hands a child for one item, hashed so the test output never holds it. */
async function hashOf(h, item) {
  const r = await vyre(h, ["vault", "run", `V=${item}`, "--", process.execPath, "-e", "console.log(require('crypto').createHash('sha256').update(process.env.V||'').digest('hex'))"]);
  return { code: r.code, hash: r.out.trim(), all: r.all };
}

async function card(h) {
  const r = await vyre(h, ["vault", "card"]);
  return { card: r.out.split("\n").find(l => l.startsWith("vyre-card:v2:")), fp: /fingerprint\s+((?:[0-9A-Z]{4} ){4}[0-9A-Z]{4})/.exec(r.out)?.[1] };
}

test("shared vault: invite, both write, a conflict, remove a member, rotation flags, no leaks", async t => {
  const alex = home(t, { name: "alex-box", vault: { keystore: "file", relay: { host: "127.0.0.1", port: 0 } } });
  const dana = home(t, { name: "dana-box", vault: { keystore: "file" } });
  const sam = home(t, { name: "sam-box", vault: { keystore: "file" } });
  for (const h of [alex, dana, sam]) assert.equal((await vyre(h, ["up"])).code, 0);

  // Alex pins and verifies both cards (invites need a verified person).
  for (const [h, name] of [[dana, "dana"], [sam, "sam"]]) {
    const c = await card(h);
    assert.ok(c.card && c.fp);
    assert.equal((await vyre(alex, ["vault", "people", "add", c.card, "--name", name])).code, 0);
    assert.match((await vyre(alex, ["vault", "people", "verify", name, c.fp])).out, /verified/);
  }

  assert.equal((await call(alex, "vault.vaults.create", { name: "team" })).vault.role, "owner");
  const token = fake("token");
  const put = await vyre(alex, ["vault", "put", "team/api-token", "--kind", "api-key"], token);
  assert.match(put.out, /shared team\/api-token · rev 1 in team/, put.all);

  // Invites: the invite carries no value, and only its person can use it.
  const invD = await call(alex, "vault.members.invite", { vault: "team", person: "dana" });
  const invS = await call(alex, "vault.members.invite", { vault: "team", person: "sam" });
  assert.ok(invD.invite.startsWith("vyre-invite:v1:") && !invD.invite.includes(token));
  const wrong = await vyre(sam, ["call", "vault.members.accept", JSON.stringify({ invite: invD.invite })]);
  assert.match(wrong.all, /made for another Vyre/);
  assert.equal((await call(dana, "vault.members.accept", { invite: invD.invite })).vault.name, "team");
  assert.equal((await call(sam, "vault.members.accept", { invite: invS.invite })).vault.name, "team");
  assert.equal((await hashOf(dana, "team/api-token")).hash, sha(token), "dana uses what alex wrote");

  // Dana writes too; alex and sam see it.
  const dbpw = fake("db");
  assert.match((await vyre(dana, ["vault", "put", "team/db-password"], dbpw)).out, /shared team\/db-password/);
  await call(sam, "vault.vaults.sync", {});
  assert.equal((await hashOf(alex, "team/db-password")).hash, sha(dbpw));
  assert.equal((await hashOf(sam, "team/db-password")).hash, sha(dbpw));

  // Both change api-token from the same base: alex first, then dana. Same field: a conflict.
  const aTok = fake("alex"), dTok = fake("dana");
  assert.match((await vyre(alex, ["vault", "put", "team/api-token"], aTok)).out, /rev \d+/);
  const clash = await vyre(dana, ["vault", "put", "team/api-token"], dTok);
  assert.match(clash.out, /conflict team\/api-token/, clash.all);
  assert.equal((await hashOf(dana, "team/api-token")).hash, sha(aTok), "the home's version is current");
  const danaView = (await call(dana, "vault.vaults.list", {})).vaults[0];
  assert.equal(danaView.conflicts, 1);

  // Remove dana: a new key, every item she could read flagged, and her copy gone.
  const removed = await call(alex, "vault.members.remove", { vault: "team", person: "dana" });
  assert.equal(removed.kv, 2);
  assert.deepEqual(removed.rotate.sort(), ["team/api-token", "team/db-password"]);
  assert.match((await vyre(alex, ["vault", "list"])).out, /team\/api-token[^\n]*rotate/);
  const after = fake("after");
  await vyre(alex, ["vault", "put", "team/new-key"], after);
  await call(sam, "vault.vaults.sync", {});
  assert.equal((await hashOf(sam, "team/new-key")).hash, sha(after), "sam, still in, gets the new key");
  const danaSync = await call(dana, "vault.vaults.sync", {});
  assert.equal(danaSync.synced[0].removed, true);
  assert.notEqual((await hashOf(dana, "team/api-token")).code, 0, "dana's copy is gone");
  assert.notEqual((await hashOf(dana, "team/new-key")).code, 0);
  const members = (await call(alex, "vault.vaults.list", {})).vaults[0].members.map(m => m.name).sort();
  assert.deepEqual(members, ["alex-box", "sam"]);

  const types = async h => (/** @type {any} */ (await request("GET", "/v1/events?limit=1000", undefined, { root: h }))).data.map(e => e.type);
  const alexEvents = await types(alex);
  for (const e of ["vault.member-added", "vault.member-removed", "vault.key-rotated"]) assert.ok(alexEvents.includes(e), e);
  assert.ok((await types(dana)).includes("vault.sync-conflicted"));

  // No value in plain text on any disk, in any audit trail or event list, or in any listing.
  const values = [token, dbpw, aTok, dTok, after];
  for (const h of [alex, dana, sam]) {
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.isFile() ? [path.join(d, e.name)] : []);
    for (const f of walk(h)) {
      const bytes = fs.readFileSync(f);
      for (const v of values) assert.ok(!bytes.includes(Buffer.from(v)), `a value is in plain text in ${path.relative(h, f)}`);
    }
    const said = [
      (await vyre(h, ["vault", "audit", "--limit", "1000"])).all,
      (await vyre(h, ["call", "vault.vaults.list", "{}"])).all,
      (await vyre(h, ["vault", "list"])).all,
      JSON.stringify(await request("GET", "/v1/events?limit=1000", undefined, { root: h })),
    ].join("\n");
    for (const v of values) assert.ok(!said.includes(v), "a value appeared in what vyred says");
  }
});
