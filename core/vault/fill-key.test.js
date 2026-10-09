// @ts-check
// fill-key tests: the /v1/fill/save-key HTTP contract, on a real listener over a real Vault in a
// temp folder with the file keystore. Every key is a fake built at run time from a seeded
// generator, so no key-shaped literal sits in the source. A key must never come back in a
// response, an audit row or an event.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { Fill, serveFill } from "./fill.js";
import { SCRATCH } from "../../test/scratch.mjs";

const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const PAGE = "https://console.anthropic.com";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
let seed = 0x4b657953; // "KeyS"
function fake(n) {
  let s = "";
  for (let i = 0; i < n; i++) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; s += ALNUM[(seed >>> 8) % ALNUM.length]; }
  return s;
}
const anthropic = () => ["sk-", "ant-api03-", fake(48)].join("");
const awsKey = () => ["AK", "IA", fake(16).toUpperCase().replace(/[^A-Z0-9]/g, "Q")].join("");

async function setup(t, { connect } = {}) {
  const tmp = fs.mkdtempSync(path.join(SCRATCH, "vyre-fillkey-"));
  const db = open(path.join(tmp, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const events = [];
  const vault = new Vault({ db, dir: path.join(tmp, "vault"), config: { vault: { keystore: "file" } }, emit: (type, p) => events.push({ type, p }) });
  await vault.put({ name: "example-mail", kind: "login", url: "https://mail.example.com/login", fields: { username: "alex@example.com", password: `fixture-${fake(20)}` } }, "cli");
  let clock = Date.now();
  const fill = new Fill({ vault, now: () => clock, connect });
  const srv = await serveFill({ host: "127.0.0.1", port: 0, fill });
  t.after(async () => { await srv.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const call = async (route, body, headers = {}, origin = EXT) => {
    const res = await fetch(`${srv.url}/v1/fill/${route}`, { method: "POST", headers: { "content-type": "application/json", origin, ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const { code } = fill.code({ name: "test browser" });
  const paired = (await call("pair", { code })).body.data;
  await fill.setUnlockPassphrase({ passphrase: "a long unlock passphrase" });
  const session = (await call("unlock", { passphrase: "a long unlock passphrase" }, { authorization: `Bearer ${paired.token}` })).body.data.session;
  const device = { authorization: `Bearer ${paired.token}` };
  const both = { ...device, "x-vyre-session": session };
  return { vault, fill, call, device, both, events, advance: ms => { clock += ms; } };
}

const key = (value, extra = {}) => ({ url: `${PAGE}/settings/keys`, raisedOn: `${PAGE}/settings`, value, label: "API key", ...extra });

test("save-key: one call stores a key ready to use, named from the host and label, origin recorded", async t => {
  const { vault, call, both } = await setup(t);
  const value = anthropic();
  const r = await call("save-key", key(value), both);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, { name: "console.anthropic.com-api-key", kind: "api-key", provider: "anthropic", created: true });
  const row = vault.row("console.anthropic.com-api-key");
  assert.equal(row.kind, "api-key");
  assert.equal(row.origin, PAGE, "the page's origin is recorded");
  assert.deepEqual(JSON.parse(row.hosts), [], "no login-style host");
  assert.equal((await vault.fields(row)).value, value);
  const listed = vault.list().items.find(i => i.name === row.name);
  assert.equal(listed.details.provider, "anthropic", "the provider is a detail, so it shows as a connection");
  assert.ok(!JSON.stringify(vault.list()).includes(value));

  // A different label is a different name; the same name is never reused.
  const second = await call("save-key", key(anthropic(), { label: "New key" }), both);
  assert.equal(second.body.data.name, "console.anthropic.com-new-key");
  const third = await call("save-key", key(anthropic()), both);
  assert.equal(third.body.data.name, "console.anthropic.com-api-key-2");
});

test("save-key: the kind and field follow what credential-shapes.js reads from the value", async t => {
  const { vault, call, both } = await setup(t);
  const pat = ["ghp", "_", fake(36)].join("");
  const r = await call("save-key", key(pat, { label: "Personal access token", url: "https://github.com/settings/tokens", raisedOn: "https://github.com/settings/tokens" }), both);
  assert.deepEqual([r.body.data.kind, r.body.data.provider], ["pat", "github"], JSON.stringify(r.body));
  assert.equal((await vault.fields(vault.row(r.body.data.name))).token, pat);

  // A generic string a page labelled a secret: a plain secret with no provider.
  const generic = fake(44);
  const g = await call("save-key", key(generic, { label: "secret key", generic: true }), both);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.deepEqual([g.body.data.kind, g.body.data.provider], ["secret", undefined]);
  assert.equal((await vault.fields(vault.row(g.body.data.name))).value, generic);
});

test("save-key: the same key from the same site is one item", async t => {
  const { call, both, vault } = await setup(t);
  const value = anthropic();
  const a = await call("save-key", key(value), both);
  const b = await call("save-key", key(value, { label: "Copy" }), both);
  assert.deepEqual(b.body.data, { name: a.body.data.name, kind: "api-key", created: false });
  assert.equal(vault.list().items.filter(i => i.kind === "api-key").length, 1);
});

test("save-key: a catalog provider goes to the connect hook; the answer names the module, a failing hook is not fatal", async t => {
  const calls = [];
  const { call, both } = await setup(t, { connect: async k => { calls.push(k); return { module: "voice" }; } });
  const r = await call("save-key", key(anthropic()), both);
  assert.equal(r.body.data.connected, "voice");
  assert.deepEqual(calls, [{ item: "console.anthropic.com-api-key", kind: "api-key", provider: "anthropic" }]);
  // AWS is not in the provider catalog: the item is saved and the hook is not asked.
  const aws = await call("save-key", key(awsKey(), { label: "access key" }), both);
  assert.equal(aws.status, 200, JSON.stringify(aws.body));
  assert.equal(aws.body.data.connected, undefined);
  assert.equal(calls.length, 1);

  const broken = await setup(t, { connect: async () => { throw new Error("no such need"); } });
  const ok = await broken.call("save-key", key(anthropic()), broken.both);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.created, true);
  assert.equal(ok.body.data.connected, undefined);
});

test("save-key: refused when the page origin is not the origin the chip was raised on", async t => {
  const { vault, call, both } = await setup(t);
  const other = await call("save-key", key(anthropic(), { raisedOn: "https://evil.example.net/x" }), both);
  assert.equal(other.body.error?.code, "wrong_origin", JSON.stringify(other.body));
  assert.equal(other.status, 403);
  assert.equal((await call("save-key", key(anthropic(), { raisedOn: `${PAGE}:8443` }), both)).body.error.code, "wrong_origin", "a port is another origin");
  assert.equal((await call("save-key", key(anthropic(), { raisedOn: undefined }), both)).body.error.code, "wrong_origin");
  assert.equal((await call("save-key", key(anthropic(), { raisedOn: "not a url" }), both)).body.error.code, "wrong_origin");
  assert.equal(vault.list().items.filter(i => i.kind === "api-key").length, 0);
  assert.equal((await call("save-key", key(anthropic(), { url: "ftp://console.anthropic.com" }), both)).body.error.code, "bad_input");
});

test("save-key: needs the extension, a paired device and a session; only a key-shaped secret is kept", async t => {
  const { vault, call, device, both } = await setup(t);
  const value = anthropic();
  assert.equal((await call("save-key", key(value), {})).status, 401);
  assert.equal((await call("save-key", key(value), device)).body.error.code, "session_required");
  assert.equal((await call("save-key", key(value), { ...device, "x-vyre-session": "x".repeat(43) })).body.error.code, "session_expired");
  assert.equal((await call("save-key", key(value), both, "https://console.anthropic.com")).body.error.code, "origin_refused", "a web page never reaches save-key");
  for (const [what, v] of [["a uuid", crypto.randomUUID()], ["a word", "hunter2hunter2hunter2"], ["a publishable key", ["pk", "_live_", fake(30)].join("")], ["plain text", "not a key at all"]]) {
    const r = await call("save-key", key(v), both);
    assert.equal(r.body.error?.code, "not_a_key", what);
    assert.equal(r.status, 422, what);
  }
  assert.equal((await call("save-key", key(""), both)).body.error.code, "bad_input");
  assert.equal((await call("save-key", key("x".repeat(9000)), both)).body.error.code, "bad_input");
  assert.equal(vault.list().items.filter(i => i.kind !== "login").length, 0);
});

test("save-key: undo removes only what this route made for this device and page, within two minutes", async t => {
  const { vault, call, both, advance, fill } = await setup(t);
  const made = (await call("save-key", key(anthropic()), both)).body.data.name;
  assert.equal((await call("save-key", { url: PAGE, undo: "example-mail" }, both)).body.error.code, "not_found", "a login the route did not make");
  assert.ok(vault.row("example-mail"));
  assert.equal((await call("save-key", { url: "https://other.example.net", undo: made }, both)).body.error.code, "not_found", "another page");
  assert.ok(vault.row(made));
  const done = await call("save-key", { url: PAGE, undo: made }, both);
  assert.deepEqual(done.body.data, { name: made, removed: true });
  assert.equal(vault.row(made), undefined);
  assert.equal((await call("save-key", { url: PAGE, undo: made }, both)).body.error.code, "not_found", "once");

  const late = (await call("save-key", key(anthropic()), both)).body.data.name;
  advance(2 * 60_000 + 1);
  assert.equal((await call("save-key", { url: PAGE, undo: late }, both)).body.error.code, "not_found", "too late");
  assert.ok(vault.row(late));
  assert.ok(fill.savedKeys instanceof Map);
});

test("no key from save-key appears in a response, an audit row, an event or the item list", async t => {
  const { vault, call, both, events } = await setup(t);
  const values = [anthropic(), ["ghp", "_", fake(36)].join(""), fake(44)];
  const texts = [];
  for (const v of values) texts.push(JSON.stringify(await call("save-key", key(v, { generic: true }), both)));
  texts.push(JSON.stringify(await call("save-key", key(values[0]), both)));
  texts.push(JSON.stringify(await call("save-key", key(values[1], { raisedOn: "https://evil.example.net" }), both)));
  texts.push(JSON.stringify(await call("save-key", { url: PAGE, undo: "console.anthropic.com-api-key" }, both)));
  texts.push(JSON.stringify(vault.auditTrail({ limit: 1000 })), JSON.stringify(events), JSON.stringify(vault.list()));
  for (const v of values) for (const [i, text] of texts.entries()) assert.ok(!text.includes(v), `a key appeared in output ${i}`);
  assert.ok(events.some(e => e.type === "vault.key-saved"), "an event says a key was saved, by name");
});

test("save-key: a provider-shaped key from a site that is not that provider's own is kept plain, never connected (H-K1)", async t => {
  const calls = [];
  const { vault, call, both } = await setup(t, { connect: async k => { calls.push(k); return { module: "voice" }; } });
  const evil = "https://evil.example.net";
  const r = await call("save-key", { url: `${evil}/page`, raisedOn: `${evil}/page`, value: anthropic(), label: "API key" }, both);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.provider, undefined);
  assert.equal(r.body.data.connected, undefined);
  assert.deepEqual(calls, [], "the connect hook is never asked");
  const item = vault.list().items.find(i => i.name === r.body.data.name);
  assert.equal(item.details?.provider, undefined, "no provider detail, so it is no connection");
  // A lookalike domain is not the provider either; a real subdomain is.
  const look = await call("save-key", { url: "https://anthropic.com.evil.example.net/k", raisedOn: "https://anthropic.com.evil.example.net/k", value: anthropic(), label: "b" }, both);
  assert.equal(look.body.data.provider, undefined);
  const real = await call("save-key", { url: "https://console.anthropic.com/k", raisedOn: "https://console.anthropic.com/k", value: anthropic(), label: "c" }, both);
  assert.equal(real.body.data.provider, "anthropic");
  assert.equal(calls.length, 1);
});

test("save-key: the key-issuing pages only: github outside /settings and a workspace subdomain are not the provider", async t => {
  const { call, both } = await setup(t, { connect: async () => ({ module: "voice" }) });
  const pat = () => ["ghp", "_", fake(36)].join("");
  const issue = await call("save-key", { url: "https://github.com/some/repo/issues/1", raisedOn: "https://github.com/some/repo/issues/1", value: pat(), label: "token" }, both);
  assert.equal(issue.body.data.provider, undefined, "user content on github.com");
  const settings = await call("save-key", { url: "https://github.com/settings/tokens", raisedOn: "https://github.com/settings/tokens", value: pat(), label: "token2" }, both);
  assert.equal(settings.body.data.provider, "github");
  const sneaky = await call("save-key", { url: "https://github.com/settingsx/tokens", raisedOn: "https://github.com/settingsx/tokens", value: pat(), label: "token3" }, both);
  assert.equal(sneaky.body.data.provider, undefined, "a prefix must end at a path boundary");
});
