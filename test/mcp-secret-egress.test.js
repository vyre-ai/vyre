// @ts-check
// [reviewed: trust] An agent, model, MCP or hosted caller never receives a secret-tagged value from the
// identity and vault tools this workstream added, or from a record read. The tag is the field type in
// lib/secret-keys.js. A person's own caller still receives a recovery key once.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Registry } from "../core/modules/index.js";
import { scrubVaultResult } from "../core/modules/needs-you-hold.js";
import { Events } from "../kernel/bus.js";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";
import { SECRET_FIELD_TYPES, keyIsSecret, secretSchema, secretTypeOf } from "../lib/secret-schema.js";
import { stripSecrets } from "../lib/master-secret.js";
import { open, migrate as migrateDb } from "../core/store/index.js";
import identity from "../core/identity/index.js";
import devices from "../core/devices/index.js";
import { fileIdentityStore } from "../core/spaces/identity.js";
import { forgetAll } from "../kernel/identity/holder.js";
import { readMaster } from "../kernel/identity/master.js";
import { create, put, list, lend } from "../kernel/identity/space-vault.js";

process.env.VYRE_TEST_MASTER_KDF = "cheap";

const P = {
  "vault-value": "VYRE-PLANTED-VAULT-VALUE-7f3c1a",
  "recovery-key": "VYRE-PLANTED-RECOVERY-KEY-7f3c1a",
  "master-record": "VYRE-PLANTED-MASTER-RECORD-7f3c1a",
  token: "VYRE-PLANTED-GITHUB-TOKEN-7f3c1a",
  "record-secret": "VYRE-PLANTED-RECORD-SECRET-7f3c1a",
  "connection-credential": "VYRE-PLANTED-CONNECTION-CREDENTIAL-7f3c1a",
  "invite-token": "VYRE-PLANTED-INVITE-TOKEN-7f3c1a",
};
const ALL = Object.values(P);

/** Tools this workstream added or touched that can hand back secret material. Each one is a case below. */
const LEAKING = [
  "identity.create",
  "identity.migrate",
  "identity.unlock",
  "identity.status",
  "identity.card",
  "identity.github.link",
  "devices.signin",
  "vault.space.put",
  "vault.space.use",
  "spaces.identity.create",
  "spaces.identity.code.replace",
  "records.get",
  "records.reveal",
];

/** @param {unknown} value */
function leaked(value) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return !s ? [] : ALL.filter(p => s.includes(p));
}

test("recovery key, master record, wrapped keys, space-vault values and GitHub link tokens are tagged", () => {
  for (const id of ["vault-value", "recovery-key", "master-record", "token", "record-secret"]) {
    assert.equal(SECRET_FIELD_TYPES[id].secret, true, id);
    assert.equal(secretSchema(/** @type {any} */ (id)).secret, true);
  }
  assert.equal(secretTypeOf("recoveryKey"), "recovery-key");
  assert.equal(secretTypeOf("recoveryCode"), "recovery-key");
  assert.equal(secretTypeOf("recoveryWrap"), "recovery-key");
  assert.equal(secretTypeOf("passwordWrap"), "master-record");
  assert.equal(secretTypeOf("identityWrap"), "master-record");
  assert.equal(secretTypeOf("vaultWrap"), "master-record");
  assert.equal(secretTypeOf("boxWrap"), "master-record");
  assert.equal(secretTypeOf("githubToken"), "token");
  assert.equal(secretTypeOf("githubAccessToken"), "token");
  assert.equal(secretTypeOf("ssn"), "vault-value");
});

test("each leaking tool is stripped for an agent and kept for the person", () => {
  const putDef = {
    input: { type: "object", properties: { value: secretSchema("vault-value") } },
    output: { type: "object", properties: { value: secretSchema("vault-value") } },
  };
  const cases = [
    ["identity.create", { username: "alex", recoveryKey: P["recovery-key"], recoveryWrap: P["recovery-key"] }],
    ["identity.migrate", { username: "alex", recoveryKey: P["recovery-key"] }],
    ["identity.unlock", { unlocked: true, passwordWrap: P["master-record"], identityWrap: P["master-record"], vaultWrap: P["master-record"] }],
    ["identity.status", { username: "alex", passwordWrap: P["master-record"], recoveryWrap: P["recovery-key"] }],
    ["identity.card", { name: "alex", private: true, githubToken: P.token }],
    ["identity.github.link", { login: "alex-studio", linked: true, githubToken: P.token, githubAccessToken: P.token }],
    ["devices.signin", { ok: true, username: "alex", carry: { passwordWrap: P["master-record"], identityWrap: P["master-record"], vaultWrap: P["master-record"], boxPub: "pub" } }],
    ["vault.space.put", { id: "stripe", name: "Stripe", value: P["vault-value"] }, { value: P["vault-value"] }, putDef],
    ["vault.space.use", { ok: true, status: 200, body: "ok", value: P["vault-value"] }, { value: P["vault-value"] }, putDef],
    ["spaces.identity.create", { name: "alex", recoveryCode: P["recovery-key"] }],
    ["spaces.identity.code.replace", { recoveryCode: P["recovery-key"], passwordSet: false }],
    ["records.get", { data: { name: "Ada", ssn: P["record-secret"] }, schema: { fields: [{ name: "ssn", kind: "sealed" }] } }],
    ["records.reveal", { value: P["record-secret"], expires_in_ms: 1000, ledger: [] }],
  ];
  assert.deepEqual(cases.map(c => c[0]), LEAKING);
  for (const [tool, body, input, def] of cases) {
    const mcp = scrubVaultResult("mcp", /** @type {string} */ (tool), { data: body }, input, def);
    assert.deepEqual(leaked(mcp), [], `${tool} ${JSON.stringify(mcp)}`);
    const person = scrubVaultResult("cli", /** @type {string} */ (tool), { data: body }, input, def);
    assert.equal(leaked(person).length > 0, true, /** @type {string} */ (tool));
  }
  const row = scrubVaultResult("mcp", "records.get", { data: { data: { name: "Ada", ssn: P["record-secret"] }, schema: { fields: [{ name: "ssn", kind: "sealed" }] } } });
  assert.equal(row.data.data.name, "Ada");
  assert.equal(row.data.data.ssn, undefined);
  const reveal = scrubVaultResult("mcp", "records.reveal", { data: { value: P["record-secret"], expires_in_ms: 1000 } });
  assert.equal(reveal.data.value, undefined);
  const card = stripSecrets({ to: "juno@example.com", passwordWrap: P["master-record"], note: "Invoice 1042" });
  assert.equal(JSON.stringify(card).includes(P["master-record"]), false);
  assert.equal(card.note, "Invoice 1042");
});

test("the registry strips a secret-tagged result for mcp and keeps it for the person", async () => {
  const reg = new Registry({ log: () => {}, config: { role: "local" }, paths: { root: os.tmpdir() } });
  reg.tools.set("fixture.echo", {
    name: "fixture.echo", module: "fixture", description: "echo", effect: "read", effectDeclared: true,
    callers: null, reach: "anyone", defaulted: false, internal: false, hook: false, presence: false,
    input: { type: "object", properties: { recoveryKey: secretSchema("recovery-key") } },
    output: { type: "object", properties: { recoveryKey: secretSchema("recovery-key"), passwordWrap: secretSchema("master-record"), githubToken: secretSchema("token") } },
    run: async () => ({ username: "alex", recoveryKey: P["recovery-key"], passwordWrap: P["master-record"], githubToken: P.token }),
  });
  const mcp = await reg.call("fixture.echo", { recoveryKey: P["recovery-key"] }, "mcp");
  assert.equal(mcp.data.username, "alex");
  assert.deepEqual(leaked(mcp), []);
  const person = await reg.call("fixture.echo", {}, "cli");
  assert.equal(person.data.recoveryKey, P["recovery-key"]);
  assert.equal(person.data.githubToken, P.token);
});

test("an event carrying a recovery key, a wrap or a GitHub link token is refused", () => {
  const ev = new Events(null);
  assert.throws(() => ev.emit("identity", "identity.read", { recoveryKey: P["recovery-key"] }), /secret/);
  assert.throws(() => ev.emit("identity", "identity.read", { passwordWrap: P["master-record"] }), /secret/);
  assert.throws(() => ev.emit("identity", "identity.read", { githubToken: P.token }), /secret/);
  assert.doesNotThrow(() => ev.emit("threads", "thread.started", { session: "sess-abc-12345", username: "alex" }));
});

test("identity reads and a sign-in return no secret to a non-person, and a space vault lend does not", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-egress-"));
  const db = open(path.join(root, "vyre.db"));
  const tools = new Map();
  await identity.start({
    paths: { root },
    store: { db, migrate(steps) { migrateDb(db, "identity", steps); } },
    tool(name, def) { tools.set(name, def); },
    call: async () => ({ error: { code: "failed", message: "not used" } }),
  });
  const store = fileIdentityStore(path.join(root, "spaces"));
  await store.generate();
  store.setName("alex");
  const made = await tools.get("identity.migrate").run({ password: "correct horse battery" }, { caller: "cli" });
  assert.equal(made.recoveryKey.replace(/-/g, "").length, 26);
  const master = readMaster(root);
  const secretBits = [master.recoveryWrap.ct, master.passwordWrap.ct, master.identityWrap.ct, master.vaultWrap.ct, made.recoveryKey];
  const status = await tools.get("identity.status").run({}, { caller: "mcp" });
  const card = await tools.get("identity.card").run({}, { caller: "mcp" });
  const blob = JSON.stringify({ status, card });
  for (const bit of secretBits) assert.equal(blob.includes(bit), false, bit);
  assert.equal(status.username, "alex");
  assert.equal(card.private, true);
  const subject = "gho_plan7edtokentokentokenvalue";
  const linked = await tools.get("identity.github.link").run({ login: "alex-studio", subject }, { caller: "mcp" });
  assert.deepEqual(linked, { login: "alex-studio", linked: true });
  assert.equal(JSON.stringify(linked).includes(subject), false);
  const devTools = new Map();
  await devices.start({
    paths: { root },
    store: { db, migrate(steps) { migrateDb(db, "devices", steps); } },
    tool(name, def) { devTools.set(name, def); },
  });
  const signed = await devTools.get("devices.signin").run({ server: "https://juniper.example", username: "alex", password: "correct horse battery" }, { caller: "cli" });
  assert.equal(typeof signed.carry.passwordWrap.ct, "string");
  const agentView = scrubVaultResult("mcp", "devices.signin", { data: signed }, { password: "correct horse battery" }, devTools.get("devices.signin"));
  const agentText = JSON.stringify(agentView);
  assert.equal(agentText.includes(signed.carry.passwordWrap.ct), false);
  assert.equal(agentText.includes(signed.carry.identityWrap.ct), false);
  assert.equal(agentText.includes(signed.carry.vaultWrap.ct), false);
  assert.equal(agentText.includes("correct horse battery"), false);
  await assert.rejects(
    () => devTools.get("devices.signin").run({ server: "https://juniper.example", username: "alex", password: "correct horse battery" }, { caller: "mcp" }),
    (e) => e.code === "secret_refused" && !String(e.message).includes("correct horse battery"),
  );
  const dir = path.join(root, "space-vault");
  const item = "vyre-space-secret-9f3a7c";
  create(dir);
  const stored = put(dir, { id: "stripe", name: "Stripe", value: item, hosts: ["example.com"] });
  assert.equal(JSON.stringify(stored).includes(item), false);
  assert.equal(JSON.stringify(list(dir)).includes(item), false);
  const echoed = await lend(dir, {
    id: "stripe",
    request: { url: "https://example.com/echo", method: "POST" },
    transport: async () => ({ status: 200, body: { echoed: item, ok: true } }),
  });
  assert.equal(JSON.stringify(echoed).includes(item), false);
  assert.equal(echoed.body.echoed, "[redacted]");
  const putEcho = scrubVaultResult("mcp", "vault.space.put", { data: { ...stored, value: item } }, { value: item }, tools.get("vault.space.put") || {
    input: { type: "object", properties: { value: secretSchema("vault-value") } },
    output: { type: "object", properties: { value: secretSchema("vault-value") } },
  });
  assert.equal(JSON.stringify(putEcho).includes(item), false);
  forgetAll();
  db.close();
});

/** @param {string} key */
function plantedFor(key) {
  return P[/** @type {keyof typeof P} */ (secretTypeOf(key) || "vault-value")];
}

/** @param {any} schema @param {number} [depth] */
function fill(schema, depth = 0) {
  if (!schema || depth > 3) return undefined;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const t = schema.type;
  if (t === "integer" || t === "number") return schema.minimum ?? 1;
  if (t === "boolean") return false;
  if (t === "array") {
    const one = schema.items ? fill(schema.items, depth + 1) : undefined;
    return one === undefined ? [] : [one];
  }
  if (t === "string") return "fixture";
  if (t === "object" || schema.properties || !t) {
    const props = schema.properties || {};
    const keys = Object.keys(props);
    if (!keys.length) return depth > 1 ? { name: "fixture" } : {};
    /** @type {Record<string, any>} */ const out = {};
    for (const k of keys) {
      if (keyIsSecret(k) || (props[k] && props[k].secret === true)) out[k] = plantedFor(k);
      else {
        const v = fill(props[k], depth + 1);
        if (v !== undefined) out[k] = v;
      }
    }
    for (const k of schema.required || []) if (out[k] === undefined) out[k] = props[k] && props[k].type === "number" ? 1 : "fixture";
    return out;
  }
  return undefined;
}

test("every registered tool, called as an agent with planted secrets, keeps them out of the result, the error, events, the log and stream frames", async (t) => {
  /** @type {{ stop: () => Promise<void>, registry: { tools: Map<string, any>, call: Function }, events: { latestId: () => number, since: (id: number) => any[] } } | null} */
  let d = null;
  const root = tempHome(t, { stop: () => d && d.stop() });
  /** @type {string[]} */ const logs = [];
  d = await start({ root, log: (m) => logs.push(String(m)) });
  /** @type {{ name: string, channels: string[] }[]} */ const leaks = [];
  for (const name of d.registry.tools.keys()) {
    const def = d.registry.tools.get(name);
    const input = fill(def && def.input) || {};
    const mark = logs.length;
    const before = d.events.latestId();
    /** @type {any[]} */ const frames = [];
    let result;
    try {
      result = await Promise.race([
        d.registry.call(name, input, "mcp", { partial: (/** @type {any} */ f) => frames.push(f) }),
        new Promise(resolve => setTimeout(() => resolve({ error: { code: "timeout" } }), 400)),
      ]);
    } catch (e) {
      result = { error: { message: String(/** @type {any} */ (e && e.message) || e) } };
    }
    /** @type {string[]} */ const channels = [];
    if (leaked(result).length) channels.push("result");
    if (leaked(d.events.since(before)).length) channels.push("event");
    if (leaked(logs.slice(mark).join("\n")).length) channels.push("log");
    if (leaked(frames).length) channels.push("stream");
    if (channels.length) leaks.push({ name, channels });
  }
  assert.deepEqual(leaks, [], leaks.map(l => `${l.channels.join("+")} ${l.name}`).join("\n"));
});
