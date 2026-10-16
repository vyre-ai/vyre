// @ts-check
// One identity, many spaces, one server per space (ADR 0054). The identity and the personal vault live on the
// person's device. Each space server holds that space's membership, roles and space vault.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { open, migrate as migrateDb } from "../../core/store/index.js";
import { Vault, MIGRATIONS as VAULT_MIGRATIONS } from "../../core/vault/vault.js";
import identity from "../../core/identity/index.js";
import devices from "../../core/devices/index.js";
import { createGateway } from "../gateway/index.js";
import { createGrantsStore } from "../grants/index.js";
import { createMemoryStore } from "../store/memory.js";
import { createEventLog } from "../core/events.js";
import { createChainBuilder } from "../core/chain.js";
import { canonical, sha256 } from "../core/canonical.js";
import { newRecoveryCode } from "./code.js";
import { createMaster, TEST_KDF, serverVaultKey, readMaster, identityPath } from "./master.js";
import { forgetAll } from "./holder.js";
import { x25519Pair } from "./wrap.js";
import { create, grant, put, rotate, status, openAsMember, memberBundle, serverSealFile } from "./space-vault.js";

process.env.VYRE_TEST_MASTER_KDF = "cheap";

const ALEX = "per_test_alex";
const JUNO = "per_test_juno";
const JUNIPER = "spc_test_juniper";
const NORTHWIND = "spc_test_northwind";
const PERSON_SECRET = "person-vault-9f3a";
const JUNIPER_SECRET = "juniper-vault-9f3a";
const NORTHWIND_SECRET = "northwind-vault-9f3a";

let T = 1_800_000_000_000;
const clock = () => ++T;
const used = new Set();
let proofN = 0;
const presence = {
  check: async ({ chain, op, fields, proof }) => (chain && proof && proof.op === op && canonical(proof.fields) === canonical(fields) && !used.has(proof.n) && (used.add(proof.n), true) ? null : "wrong_payload"),
};
/** @param {string} action @param {any} input @param {string} resource */
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: ++proofN });

/** @param {string} space @param {string} ownerId */
async function openSpace(space, ownerId) {
  const chains = createChainBuilder({ space, owner: ownerId, owner_uid: 501, key: Buffer.alloc(32, 4), clock, is_person: () => true });
  const log = createEventLog({ space, clock });
  const gs = createGrantsStore({ space, log, chains, clock, key: Buffer.alloc(32, 5), presence });
  const store = createMemoryStore({ clock });
  const gw = createGateway({ space, store, log, chains, clock, grantsStore: gs, presence, owner: ownerId, hasPresenceSession: () => true });
  await gs.bootstrap({ owner: ownerId });
  const ownerChain = () => chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
  const asPerson = (/** @type {string} */ who) => chains.fromFacts({ kind: "device", device_key_id: `d-${who}`, person: who, path: "direct" });
  return { space, g: gw.grants, log, ownerChain, asPerson };
}

/** @param {string} dir */
function textUnder(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ d) => {
    if (!fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out.push(fs.readFileSync(p).toString("utf8"));
    }
  };
  walk(dir);
  return out.join("\n");
}

test("one identity is owner of one space and admin of another, on two servers", async (t) => {
  const person = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-person-"));
  const juniperRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-juniper-"));
  const northRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-northwind-"));
  const db = open(path.join(person, "vyre.db"));
  t.after(() => { forgetAll(); try { db.close(); } catch { /* closed */ } fs.rmSync(person, { recursive: true, force: true }); fs.rmSync(juniperRoot, { recursive: true, force: true }); fs.rmSync(northRoot, { recursive: true, force: true }); });

  const idFile = identityPath(person);
  fs.mkdirSync(path.dirname(idFile), { recursive: true });
  fs.writeFileSync(idFile, JSON.stringify({ id: "id_alex", name: "alex", privateKey: Buffer.from("a".repeat(32)).toString("base64url") }) + "\n");
  const vaultKey = serverVaultKey(person);
  assert.ok(vaultKey);
  createMaster({
    root: person, username: "alex", id: "id_alex", password: "correct horse battery", recoveryCode: newRecoveryCode(),
    privateKeyB64: Buffer.from("a".repeat(32)).toString("base64url"), vaultKey, kdf: TEST_KDF, identityFile: idFile,
  });
  migrateDb(db, "vault", VAULT_MIGRATIONS);
  const vault = new Vault({ db, dir: path.join(person, "vault"), config: { vault: { keystore: "file" } }, emit: () => {} });
  await vault.put({ name: "personal", kind: "secret", fields: { value: PERSON_SECRET } }, "cli");
  vault.lock();

  const tools = new Map();
  await identity.start({
    paths: { root: person },
    store: { db, migrate(steps) { migrateDb(db, "identity", steps); } },
    tool(name, def) { tools.set(name, def); },
    call: async () => ({ error: { code: "failed", message: "not used" } }),
  });
  const devTools = new Map();
  await devices.start({
    paths: { root: person },
    store: { db, migrate(steps) { migrateDb(db, "devices", steps); } },
    tool(name, def) { devTools.set(name, def); },
  });

  const unlocked = await tools.get("identity.unlock").run({ password: "correct horse battery" }, { caller: "cli" });
  assert.equal(unlocked.username, "alex");
  assert.equal(unlocked.id, "id_alex");
  await tools.get("identity.lock").run({}, { caller: "cli" });
  const onJuniper = await devTools.get("devices.signin").run({ server: "https://juniper.example", username: "alex", password: "correct horse battery" }, { caller: "cli" });
  await tools.get("identity.lock").run({}, { caller: "cli" });
  const onNorth = await devTools.get("devices.signin").run({ server: "https://northwind.example", username: "alex", password: "correct horse battery" }, { caller: "cli" });
  assert.equal(onJuniper.ok, true);
  assert.equal(onNorth.ok, true);
  assert.equal(onJuniper.id, onNorth.id);
  assert.equal(onJuniper.username, "alex");
  assert.equal(onNorth.server, "https://northwind.example");
  const servers = db.prepare("SELECT server FROM devices_signin ORDER BY server").all().map((/** @type {any} */ r) => r.server);
  assert.deepEqual(servers, ["https://juniper.example", "https://northwind.example"]);

  const juniper = await openSpace(JUNIPER, ALEX);
  const north = await openSpace(NORTHWIND, JUNO);
  await juniper.g.setRole(juniper.ownerChain(), { person: JUNO, role: "member" }, { presence: proof("grants.role", { person: JUNO, role: "member" }, `vyre://${JUNIPER}/member/${JUNO}`) });
  await north.g.setRole(north.ownerChain(), { person: ALEX, role: "admin" }, { presence: proof("grants.role", { person: ALEX, role: "admin" }, `vyre://${NORTHWIND}/member/${ALEX}`) });
  assert.equal((await juniper.g.members.get(juniper.ownerChain(), ALEX)).role, "owner");
  assert.equal((await north.g.members.get(north.asPerson(ALEX), ALEX)).role, "admin");

  const alexBox = x25519Pair();
  const junoBox = x25519Pair();
  const juniperVault = path.join(juniperRoot, "identity", "space-vaults", JUNIPER);
  const northVault = path.join(northRoot, "identity", "space-vaults", NORTHWIND);
  create(juniperVault);
  create(northVault);
  grant(juniperVault, ALEX, alexBox.pub);
  grant(juniperVault, JUNO, junoBox.pub);
  grant(northVault, ALEX, alexBox.pub);
  put(juniperVault, { id: "studio", name: "Studio", value: JUNIPER_SECRET, hosts: ["example.com"] });
  put(northVault, { id: "bakery", name: "Bakery", value: NORTHWIND_SECRET, hosts: ["example.com"] });

  const handed = await juniper.g.transferOwner(juniper.ownerChain(), { to: JUNO }, { presence: proof("grants.role", { transfer: { to: JUNO, demote_to: "admin" } }, `vyre://${JUNIPER}/member/${JUNO}`) });
  assert.equal(handed.owner, JUNO);
  assert.equal(handed.previous_role, "admin");
  assert.equal((await juniper.g.members.get(juniper.asPerson(JUNO), ALEX)).role, "admin");
  assert.equal((await north.g.members.get(north.ownerChain(), JUNO)).role, "owner");
  assert.equal((await north.g.members.get(north.asPerson(ALEX), ALEX)).role, "admin");
  assert.ok(juniper.log.read({}).some((/** @type {any} */ e) => e.type === "owner.changed" && e.data.owner_change && e.data.owner_change.space === JUNIPER));
  assert.equal(north.log.read({}).some((/** @type {any} */ e) => e.type === "owner.changed" && e.data.owner_change && e.data.owner_change.op !== "add"), false);

  const rotated = rotate(juniperVault);
  assert.equal(rotated.generation, 2);
  assert.equal(status(juniperVault).generation, 2);
  assert.equal(status(northVault).generation, 1);
  assert.equal(openAsMember(juniperVault, ALEX, alexBox.priv, "studio"), JUNIPER_SECRET);
  assert.equal(openAsMember(northVault, ALEX, alexBox.priv, "bakery"), NORTHWIND_SECRET);

  const bundle = memberBundle(juniperVault);
  const serverRow = JSON.parse(fs.readFileSync(path.join(juniperVault, "gen", "2", "server.json"), "utf8"));
  assert.equal(JSON.stringify(bundle).includes(serverRow.sealed.ct), false);
  assert.equal(fs.existsSync(path.join(person, "identity", "master.json")), true);
  assert.equal(fs.existsSync(path.join(person, "vault", "server-wrap.json")), true);
  assert.equal(fs.existsSync(path.join(person, "identity", "space-vaults")), false);
  assert.equal(fs.existsSync(path.join(juniperRoot, "identity", "master.json")), false);
  assert.equal(fs.existsSync(path.join(northRoot, "identity", "master.json")), false);
  assert.equal(fs.existsSync(path.join(juniperRoot, "vault")), false);
  assert.equal(fs.existsSync(path.join(northRoot, "vault")), false);
  assert.deepEqual(fs.readdirSync(path.join(juniperRoot, "identity", "space-vaults")).filter(n => n.startsWith("spc_")), [JUNIPER]);
  assert.deepEqual(fs.readdirSync(path.join(northRoot, "identity", "space-vaults")).filter(n => n.startsWith("spc_")), [NORTHWIND]);
  const juniperSeal = serverSealFile(juniperVault);
  const northSeal = serverSealFile(northVault);
  assert.equal(juniperSeal.startsWith(juniperRoot), true);
  assert.equal(northSeal.startsWith(northRoot), true);
  assert.equal(fs.existsSync(juniperSeal), true);
  assert.equal(fs.existsSync(northSeal), true);
  const juniperText = textUnder(juniperRoot);
  const northText = textUnder(northRoot);
  assert.equal(juniperText.includes(PERSON_SECRET), false);
  assert.equal(northText.includes(PERSON_SECRET), false);
  assert.equal(juniperText.includes(NORTHWIND_SECRET), false);
  assert.equal(northText.includes(JUNIPER_SECRET), false);
  assert.equal(textUnder(person).includes(JUNIPER_SECRET), false);
  assert.equal(textUnder(person).includes(NORTHWIND_SECRET), false);
  assert.equal(readMaster(juniperRoot), null);
  assert.equal(readMaster(northRoot), null);
  assert.equal(readMaster(person).username, "alex");
});
