// @ts-check
// [reviewed: trust] An agent, model, MCP or hosted caller never receives a secret-tagged value.
// The tag is the field type, so the tool name does not matter. This walks every tool the registry
// actually registered.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";
import { scrubVaultResult } from "../core/modules/needs-you-hold.js";
import { SECRET_FIELD_TYPES, keyIsSecret, secretSchema, secretTypeOf } from "../lib/secret-schema.js";

const P = {
  "vault-value": "VYRE-PLANTED-VAULT-VALUE-7f3c1a",
  "recovery-key": "VYRE-PLANTED-RECOVERY-KEY-7f3c1a",
  "master-record": "VYRE-PLANTED-MASTER-RECORD-7f3c1a",
  token: "VYRE-PLANTED-TOKEN-7f3c1a",
  "record-secret": "VYRE-PLANTED-RECORD-SECRET-7f3c1a",
  "connection-credential": "VYRE-PLANTED-CONNECTION-CREDENTIAL-7f3c1a",
  "invite-token": "VYRE-PLANTED-INVITE-TOKEN-7f3c1a",
};
const ALL = Object.values(P);

/** @param {string} key */
function plantedFor(key) {
  return P[/** @type {keyof typeof P} */ (secretTypeOf(key) || "vault-value")];
}

/** What a free object carries: every secret type, plus a sealed record field beside its schema. */
function bag() {
  return {
    name: "fixture",
    password: P["master-record"],
    recoveryKey: P["recovery-key"],
    recoveryWrap: P["recovery-key"],
    passwordWrap: P["master-record"],
    identityWrap: P["master-record"],
    vaultWrap: P["master-record"],
    token: P.token,
    client_secret: P["connection-credential"],
    secret_access_key: P["connection-credential"],
    inviteToken: P["invite-token"],
    private_key: P["vault-value"],
    kind: "login",
    fields: { username: "alex", password: P["vault-value"] },
    data: { name: "Ada", ssn: P["record-secret"] },
    schema: { fields: [{ name: "ssn", kind: "sealed", secret: true, secretType: "record-secret" }] },
    value: P["vault-value"],
  };
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
    if (!keys.length) return depth > 1 ? { name: "fixture" } : bag();
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

/** @param {unknown} value */
function leaked(value) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return !s ? [] : ALL.filter(p => s.includes(p));
}

test("every secret-bearing field type is tagged on its schema", () => {
  for (const [id, spec] of Object.entries(SECRET_FIELD_TYPES)) {
    assert.equal(spec.secret, true, id);
    assert.equal(spec.secretType, id);
    assert.equal(secretSchema(/** @type {any} */ (id)).secret, true);
  }
  assert.equal(secretTypeOf("recoveryKey"), "recovery-key");
  assert.equal(secretTypeOf("recoveryWrap"), "recovery-key");
  assert.equal(secretTypeOf("passwordWrap"), "master-record");
  assert.equal(secretTypeOf("identityWrap"), "master-record");
  assert.equal(secretTypeOf("vaultWrap"), "master-record");
  assert.equal(secretTypeOf("client_secret"), "connection-credential");
  assert.equal(secretTypeOf("inviteToken"), "invite-token");
  assert.equal(secretTypeOf("secret_access_key"), "connection-credential");
});

test("tagged secrets are stripped for an agent and kept for the person, whatever the tool is named", () => {
  const cases = [
    ["records.reveal", { value: P["record-secret"], expires_in_ms: 1000, ledger: [] }],
    ["records.get", { data: { name: "Ada", ssn: P["record-secret"] }, schema: { fields: [{ name: "ssn", kind: "sealed" }] } }],
    ["identity.create", { username: "alex", recoveryKey: P["recovery-key"], recoveryWrap: P["recovery-key"] }],
    ["identity.unlock", { unlocked: true, passwordWrap: P["master-record"], identityWrap: P["master-record"], vaultWrap: P["master-record"] }],
    ["connections.get", { client_id: "pub", client_secret: P["connection-credential"] }],
    ["invites.create", { inviteToken: P["invite-token"], space: "home" }],
    ["cloud.get", { access_key_id: "AKIA", secret_access_key: P["connection-credential"] }],
    ["vault.item", { kind: "login", fields: { username: "alex", password: P["vault-value"] } }],
  ];
  for (const [tool, body] of cases) {
    const mcp = scrubVaultResult("mcp", tool, { data: body });
    assert.equal(leaked(mcp).length, 0, `${tool} ${JSON.stringify(mcp)}`);
    const person = scrubVaultResult("cli", tool, { data: body });
    assert.equal(leaked(person).length > 0, true, tool);
  }
  const reveal = scrubVaultResult("mcp", "records.reveal", { data: { value: P["record-secret"], expires_in_ms: 1000 } });
  assert.equal(reveal.data.value, undefined);
  const row = scrubVaultResult("mcp", "records.get", { data: { data: { name: "Ada", ssn: P["record-secret"] }, schema: { fields: [{ name: "ssn", kind: "sealed" }] } } });
  assert.equal(row.data.data.name, "Ada");
  assert.equal(row.data.data.ssn, undefined);
  const lent = scrubVaultResult("mcp", "vault.request", { data: { status: 200, body: "ok", token: P.token } });
  assert.equal(lent.data.token, undefined);
  assert.equal(lent.data.body, "ok");
});

test("nested secret strings are stripped at any depth; metadata objects named secret or credential stay", () => {
  const secret = P.token;
  const body = {
    plan: { secret: { name: "STRIPE_KEY", class: "secret", ref: "vault://harlow/stripe", use: ["build"] } },
    credential: { item: "" },
    nested: { arr: [{ token: secret }, { label: "ok" }], deep: { wrap: { password: secret } } },
  };
  const mcp = scrubVaultResult("mcp", "publish.secret.grant", { data: body });
  assert.equal(leaked(mcp).length, 0, JSON.stringify(mcp));
  assert.equal(mcp.data.plan.secret.class, "secret");
  assert.equal(mcp.data.credential.item, "");
  assert.equal(mcp.data.nested.arr[0].token, undefined);
  assert.equal(mcp.data.nested.arr[1].label, "ok");
  assert.equal(mcp.data.nested.deep.wrap.password, undefined);
  const person = scrubVaultResult("cli", "publish.secret.grant", { data: body });
  assert.ok(leaked(person).length > 0);
});

test("every registered tool, called as an agent with planted secrets, keeps them out of the result, the error, the card, events, the log and stream frames", async (t) => {
  const root = tempHome(t);
  /** @type {string[]} */ const logs = [];
  const d = await start({ root, log: (m) => logs.push(String(m)) });
  t.after(() => d.stop());
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
