// @ts-check
// needs: the provider catalog, vault.need's states and vault.connect (ADR 0028, decision 9a),
// inside a real vyred in a temp home, with a synthetic module that declares what it needs.
// Every value is made at run time; none may appear in any reply, event or log line.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, writeModule } from "../../test/helpers.js";
import { PROVIDERS, CAPABILITIES, provider, checkProviderFields, checkServiceAccount } from "./providers.js";
import { KINDS, SPEC, cleanDetails } from "../../lib/vault-kinds/kinds.js";

const hex = n => crypto.randomBytes(n).toString("hex");

test("providers: every entry has the catalog's shape, and fits its kinds", () => {
  const needed = ["deepgram", "openai", "elevenlabs", "anthropic", "claude-setup-token", "github", "cloudflare",
    "telegram", "google-oauth", "google-dwd", "google-apps-script", "imap-smtp", "mcp-bearer"];
  for (const n of needed) assert.ok(provider(n), `${n} is missing from the catalog`);
  assert.equal(provider("constructor"), null);
  for (const [name, p] of Object.entries(PROVIDERS)) {
    assert.equal(p.name, name);
    assert.ok(p.label && typeof p.label === "string");
    assert.ok(p.kinds.length && p.kinds.every(k => KINDS.includes(/** @type {any} */ (k))), `${name} kinds`);
    assert.ok(["field", "file", "oauth"].includes(p.how), `${name} how`);
    assert.ok(p.capabilities.every(c => CAPABILITIES.includes(/** @type {any} */ (c))), `${name} capabilities`);
    assert.ok(p.help === null || /^https:\/\//.test(p.help), `${name} help`);
    assert.deepEqual(cleanDetails({ provider: name }), { provider: name }, `${name} is not a usable details.provider`);
    for (const f of p.fields) {
      assert.ok(/^[a-z_]+$/.test(f.name) && f.label && typeof f.secret === "boolean", `${name}.${f.name}`);
      if (f.pattern) new RegExp(f.pattern);
    }
    if (p.how === "oauth") { assert.ok(p.next && p.next.tool); assert.equal(p.fields.length, 0); }
    else {
      assert.ok(p.fields.some(f => f.secret), `${name} has no secret field`);
      for (const k of p.kinds) assert.ok(!SPEC[k].need.length || SPEC[k].need.some(f => p.fields.some(x => x.name === f)), `${name} fields cannot make a ${k}`);
    }
    if (p.how === "file") assert.ok(p.fields.find(f => f.secret));
  }
  assert.equal(PROVIDERS["google-dwd"].kinds[0], "cloud");
  assert.equal(PROVIDERS["google-oauth"].next?.tool, "google.connect");
  assert.equal(PROVIDERS["google-apps-script"].pick, true);
  assert.deepEqual(PROVIDERS["imap-smtp"].fields.map(f => f.name), ["imap_host", "imap_port", "smtp_host", "smtp_port", "username", "password", "from", "security"]);
  assert.throws(() => { /** @type {any} */ (PROVIDERS).openai.label = "x"; });
});

test("providers: field checks name the field, never the value", () => {
  const secret = "sk-" + hex(20);
  assert.deepEqual(checkProviderFields(PROVIDERS.openai, { value: ` ${secret} ` }), { value: secret });
  const msgs = [];
  for (const [p, f] of [["openai", {}], ["openai", { value: "nope-" + secret }], ["openai", { value: secret, extra: "1" }],
    ["imap-smtp", { imap_host: "imap.northwind.test", imap_port: "993", smtp_host: "smtp.northwind.test", smtp_port: "465", username: "kit", password: secret, security: "ssl" }]]) {
    try { checkProviderFields(PROVIDERS[p], f); assert.fail(`${p} took bad fields`); }
    catch (e) { msgs.push(/** @type {Error} */ (e).message); }
  }
  assert.match(msgs[0], /needs api key \(value\)/);
  assert.match(msgs[1], /value does not look like/);
  assert.match(msgs[2], /has no field extra/);
  assert.match(msgs[3], /security does not look like/);
  for (const m of msgs) assert.ok(!m.includes(secret));
  assert.throws(() => checkServiceAccount("{"), /not JSON/);
  assert.throws(() => checkServiceAccount(JSON.stringify({ type: "authorized_user" })), /service_account/);
  assert.throws(() => checkServiceAccount(JSON.stringify({ type: "service_account", client_email: "kit@northwind.test" })), /private_key/);
});

const TALKER = `export default { async start(ctx) {
  ctx.tool("talker.use", { input: { type: "object", properties: { name: { type: "string" }, field: { type: "string" } } },
    run: async ({ name, field }) => { const v = await ctx.vault.fetch(name, field ? { field } : {});
      const c = await import("node:crypto"); return { sha: c.createHash("sha256").update(String(v)).digest("hex") }; } });
  return { async stop() {} };
} };`;

const CREDS = [
  { id: "deepgram", kind: "api-key", provider: "deepgram", purpose: "words as you speak", group: "speech", item: "talker-deepgram-key" },
  { id: "openai", kind: "api-key", provider: "openai", purpose: "words on release", group: "speech" },
  { id: "elevenlabs", kind: "api-key", provider: "elevenlabs", purpose: "spoken replies", group: "speech" },
  { id: "github", kind: "pat", provider: "github", purpose: "read the repo", optional: true },
  { id: "drive", kind: "cloud", provider: "google-dwd", purpose: "files for Northwind Bakery" },
  { id: "gmail", kind: "oauth", provider: "google-oauth", purpose: "mail for Harlow Legal" },
  { id: "mail", kind: "env-set", provider: "imap-smtp", purpose: "a mailbox" },
  { id: "wrong", kind: "secret", provider: "openai", purpose: "a kind the catalog does not keep openai as" },
];

async function boot(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", transcripts: [], vault: { keystore: "file", reminders: false },
    modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  writeModule(path.join(root, "modules"), "talker", { does: { tools: ["talker.use"] }, needs: { credentials: CREDS } }, TALKER);
  // Presence finds a person unless a test turns `deny` on; tools that declare it are checked.
  const pres = { deny: false,
    required: (_tool, def) => Boolean(def && def.presence),
    verify: async () => (pres.deny ? { ok: false, code: "presence_required", message: "prove presence" } : { ok: true, method: "test" }),
    challenge: async () => ({ error: { code: "bad_input", message: "no challenge in this test" } }) };
  const lines = [];
  // The talker stands for a module of Vyre's own that a person connected credentials to (needs.credentials, ctx.vault.fetch), so it sits in a first-party root: with the kernel on, an added module runs in the sandbox with no ctx and
  // could never fetch a value (kernel/modules/child.js), which is the rule and not what this test is about.
  const d = await start({ root, presence: pres, firstPartyRoots: [path.join(root, "modules")], log: (m, x) => lines.push(m + (x ? " " + JSON.stringify(x) : "")) });
  t.after(() => d.stop());
  return { root, d, pres, lines, as: caller => (tool, input = {}) => call(tool, input, { root, caller }) };
}

test("needs: every state, connect for fields, a file and a sign-in, refusals, presence, and no value anywhere", async t => {
  const { d, pres, lines, as } = await boot(t);
  const cli = as("cli"), mcp = as("mcp");
  const outs = [];
  const values = [];
  const v = s => (values.push(s), s);
  const need = async (input = { module: "talker" }) => { const r = await cli("vault.need", input); assert.ok(!r.error, JSON.stringify(r.error)); outs.push(r); return r.data; };
  const stateOf = (data, id) => data.needs.find(n => n.id === id).state;

  // missing: nothing is saved yet. The form carries field names, labels and the secret flag only.
  let data = await need();
  assert.equal(data.needs.length, CREDS.length);
  assert.ok(data.needs.every(n => n.state === "missing"));
  const dg = data.needs.find(n => n.id === "deepgram");
  assert.deepEqual({ ...dg, fields: undefined }, { module: "talker", id: "deepgram", kind: "api-key", provider: "deepgram", purpose: "words as you speak",
    item: "talker-deepgram-key", group: "speech", optional: false, state: "missing", how: "field", fields: undefined, help: "https://console.deepgram.com/" });
  assert.deepEqual(dg.fields, [{ name: "value", label: "API key", secret: true }]);
  assert.equal(data.needs.find(n => n.id === "openai").item, "talker-openai", "item defaults to <module>-<id>");
  assert.equal(data.needs.find(n => n.id === "github").optional, true);
  assert.deepEqual(data.needs.find(n => n.id === "gmail").next, { tool: "google.connect" });
  assert.equal(data.needs.find(n => n.id === "drive").how, "file");
  assert.deepEqual(data.groups, [{ module: "talker", group: "speech", ready: false, members: ["deepgram", "openai", "elevenlabs"] }]);
  assert.ok((await need({})).needs.some(n => n.module === "talker"), "vault.need with no module lists every module");
  assert.match((await cli("vault.need", { module: "nobody" })).error.message, /no module named nobody/);
  assert.equal((await mcp("vault.need", { module: "talker" })).error.code, "denied", "vault.need is for people's surfaces");

  // not_granted: the item is there, with no grant to talker.
  await cli("vault.put", { name: "talker-openai", kind: "api-key", value: v("sk-" + hex(24)) });
  assert.equal(stateOf(await need(), "openai"), "not_granted");
  // pending: Claude asked for the grant, and it waits for a person.
  assert.equal((await mcp("vault.grant", { name: "talker-openai", module: "talker" })).data.grant.status, "pending");
  assert.equal(stateOf(await need(), "openai"), "pending");
  // expired: the item's own expiry has passed, whatever its grant says.
  await cli("vault.put", { name: "talker-elevenlabs", kind: "api-key", value: v(hex(20)), details: { expires: Date.now() - 86400_000 } });
  await cli("vault.grant", { name: "talker-elevenlabs", module: "talker" });
  assert.equal(stateOf(await need(), "elevenlabs"), "expired");

  // connect with fields: checked, stored with the kind and provider, granted, announced.
  const key = v(hex(20));
  const c = await cli("vault.connect", { module: "talker", need: "deepgram", fields: { value: key } });
  outs.push(c);
  assert.ok(!c.error, JSON.stringify(c.error));
  assert.equal(c.data.item, "talker-deepgram-key"); assert.equal(c.data.module, "talker"); assert.equal(c.data.need, "deepgram");
  assert.equal(c.data.provider, "deepgram"); assert.equal(c.data.granted, true); assert.equal(c.data.grant.status, "active");
  const listed = (await cli("vault.list", { filter: "talker-deepgram-key" })).data.items[0];
  assert.equal(listed.kind, "api-key"); assert.equal(listed.details.provider, "deepgram");
  assert.deepEqual(listed.grants, [{ module: "talker" }]);
  const used = await cli("talker.use", { name: "talker-deepgram-key" });
  assert.equal(used.data.sha, crypto.createHash("sha256").update(key).digest("hex"), "the module fetched what was connected");
  data = await need();
  assert.equal(stateOf(data, "deepgram"), "ready");
  assert.equal(data.groups[0].ready, true, "a group is ready when any member is");
  const ev = d.registry.deps.events.since(0, { type: "vault.connected" });
  assert.deepEqual(ev.map(e => e.payload ?? e.data), [{ module: "talker", need: "deepgram", item: "talker-deepgram-key", provider: "deepgram" }]);

  // Bad fields are refused by name, and nothing is stored.
  const bads = [
    [{ module: "talker", need: "openai", fields: { value: v("not-an-openai-" + hex(8)) } }, /value does not look like/],
    [{ module: "talker", need: "openai", fields: {} }, /needs api key/],
    [{ module: "talker", need: "deepgram", fields: { value: v(hex(10)), extra: "1" } }, /has no field extra/],
    [{ module: "talker", need: "deepgram", fields: { value: v("sk-ant-" + hex(16)) } }, /looks like a key for anthropic, not Deepgram/],
    [{ module: "talker", need: "github", fields: { token: v("ghp_" + hex(8)) } }, /token does not look like/],
    [{ module: "talker", need: "deepgram", file: { content: "{}" } }, /takes fields, not a file/],
    [{ module: "talker", need: "wrong", fields: { value: v("sk-" + hex(24)) } }, /is kept as api-key/],
    [{ module: "talker", need: "nope", fields: {} }, /declares no need nope/],
    [{ module: "nobody", need: "x", fields: {} }, /no module named nobody/],
    [{ module: "talker", need: "drive", fields: { subject: "juno@harlow.test" } }, /needs the key file/],
    [{ module: "talker", need: "drive", file: { content: JSON.stringify({ type: "service_account", client_email: "kit@northwind.test" }) }, fields: { subject: "juno@harlow.test" } }, /private_key/],
  ];
  for (const [input, re] of bads) {
    const r = await cli("vault.connect", input);
    outs.push(r);
    assert.ok(r.error, `took ${JSON.stringify(input.need)}`);
    assert.match(r.error.message, re);
  }
  assert.equal((await cli("vault.list", { filter: "talker-github" })).data.items.length, 0);

  // A file: a service-account JSON, with the subject to act as.
  const pk = v(hex(48));
  const sa = JSON.stringify({ type: "service_account", project_id: "northwind-bakery", client_email: "orders@northwind-bakery.iam.gserviceaccount.test",
    private_key: "-----BEGIN " + `PRIVATE KEY-----\n${pk}\n-----END ` + "PRIVATE KEY-----\n" });
  const f = await cli("vault.connect", { module: "talker", need: "drive", file: { content: sa, filename: "northwind-sa.json" }, fields: { subject: "kit@northwind.test", scopes: "https://www.googleapis.com/auth/drive.readonly" } });
  outs.push(f);
  assert.ok(!f.error, JSON.stringify(f.error));
  assert.equal(f.data.granted, true);
  const drive = (await cli("vault.list", { filter: "talker-drive" })).data.items[0];
  assert.equal(drive.kind, "cloud"); assert.deepEqual(drive.fields.sort(), ["json", "scopes", "subject"]);
  assert.equal(drive.details.provider, "google-dwd"); assert.equal(drive.details.filename, "northwind-sa.json");
  assert.equal((await cli("talker.use", { name: "talker-drive", field: "json" })).data.sha, crypto.createHash("sha256").update(sa).digest("hex"));

  // An env-set: IMAP and SMTP.
  const pw = v(hex(12));
  const m = await cli("vault.connect", { module: "talker", need: "mail", label: "kit at Northwind",
    fields: { imap_host: "imap.northwind.test", imap_port: "993", smtp_host: "smtp.northwind.test", smtp_port: "465", username: "kit", password: pw, security: "tls" } });
  outs.push(m);
  assert.ok(!m.error, JSON.stringify(m.error));
  const mail = (await cli("vault.list", { filter: "talker-mail" })).data.items[0];
  assert.equal(mail.kind, "env-set"); assert.equal(mail.description, "kit at Northwind"); assert.equal(mail.details.provider, "imap-smtp");

  // A sign-in: nothing stored, the next tool named.
  const o = await cli("vault.connect", { module: "talker", need: "gmail", label: "juno" });
  outs.push(o);
  assert.deepEqual(o.data, { item: "talker-gmail", module: "talker", need: "gmail", provider: "google-oauth", granted: false, grant: null, next: { tool: "google.connect", input: { name: "juno" } } });
  assert.equal((await cli("vault.list", { filter: "talker-gmail" })).data.items.length, 0);
  assert.equal(d.registry.deps.events.since(0, { type: "vault.connected" }).length, 3);

  // Claude is refused, whatever it sends.
  const fromClaude = await mcp("vault.connect", { module: "talker", need: "github", fields: { token: v("ghp_" + hex(20)) } });
  outs.push(fromClaude);
  assert.equal(fromClaude.error.code, "denied");
  assert.equal((await cli("vault.list", { filter: "talker-github" })).data.items.length, 0);

  // Presence: without a person, vault.connect stores nothing; vault.need still answers.
  assert.equal(d.registry.listTools("cli").find(x => x.name === "vault.connect").presence, true);
  assert.equal(d.registry.listTools("cli").find(x => x.name === "vault.need").presence, undefined);
  pres.deny = true;
  const away = await cli("vault.connect", { module: "talker", need: "github", fields: { token: v("ghp_" + hex(20)) } });
  outs.push(away);
  assert.equal(away.error.code, "presence_required");
  assert.equal(stateOf(await need(), "github"), "missing");
  pres.deny = false;

  // No value in any reply, event or log line.
  const all = JSON.stringify(outs) + JSON.stringify(d.registry.deps.events.since(0, { limit: 1000 })) + lines.join("\n");
  for (const x of values) assert.ok(!all.includes(x), "a value leaked into a reply, an event or a log line");
});
