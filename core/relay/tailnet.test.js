// @ts-check
// ADR 0046's two halves on their own: the box's Tailscale API calls against a fake fetch, and
// the desktop's `tailscale up` against a fake binary that writes down what it saw. Nothing here
// reaches api.tailscale.com or a real tailscale.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tailscaleApi, useTailscaleApi, parseCredential, joinWithKey, canJoin, installCommand, desktopJoin, pairedBox, DEVICE_TAG, KEY_TTL_S, JOIN_PATH } from "./tailnet.js";
import { installCommand as namesInstall } from "../names/tailscale.js";
import { redeem } from "./redeem.js";
import { start } from "../daemon/index.js";
import { HUMAN_ONLY } from "../presence/index.js";
import { createRelay } from "../../relay/node/server.js";
import { connect } from "../../relay/client/client.js";
import { nodeCrypto, fileKeyStore } from "../../relay/client/nodecrypto.js";
import { tempHome } from "../../test/helpers.js";

const KEY = "tskey-auth-kFAKE0CNTRL-0123456789abcdef";
const CRED = JSON.stringify({ client_id: "kFAKEid", client_secret: "tskey-client-kFAKEid-secret" });

/** A fake Tailscale API: an OAuth token, then whatever `routes` answers. */
function fakeApi(t, routes = {}, credential = undefined) {
  /** @type {Array<{ method: string, url: string, headers: any, body: any }>} */
  const seen = [];
  const fetch = /** @type {any} */ (async (url, init = {}) => {
    const u = new URL(url);
    seen.push({ method: init.method || "GET", url: u.pathname, headers: init.headers || {}, body: init.body });
    const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (u.pathname === "/api/v2/oauth/token") return reply(200, { access_token: "tok-fake", token_type: "Bearer" });
    const r = routes[`${init.method || "GET"} ${u.pathname}`];
    return r ? reply(...r) : reply(404, { message: "not found" });
  });
  t.after(useTailscaleApi({ fetch, base: "https://api.example.invalid", ...(credential ? { credential } : {}) }));
  return seen;
}

test("tailnet: a minted key is single use, pre-approved, not ephemeral, tagged tag:vyre-device, 5 minutes", async t => {
  const seen = fakeApi(t, { "POST /api/v2/tailnet/-/keys": [200, { id: "k1", key: KEY, expires: new Date(Date.now() + 300_000).toISOString() }] });
  const api = tailscaleApi({ credential: async () => CRED });
  const got = await api.mintKey("abcdefghijklmnop");
  assert.equal(got.key, KEY);
  const tok = seen.find(s => s.url === "/api/v2/oauth/token");
  assert.match(String(tok && tok.body), /client_id=kFAKEid/);
  assert.match(String(tok && tok.body), /grant_type=client_credentials/);
  const mint = /** @type {any} */ (seen.find(s => s.url === "/api/v2/tailnet/-/keys"));
  assert.equal(mint.headers.authorization, "Bearer tok-fake");
  const body = JSON.parse(mint.body);
  assert.deepEqual(body.capabilities.devices.create, { reusable: false, ephemeral: false, preauthorized: true, tags: [DEVICE_TAG] });
  assert.equal(body.expirySeconds, KEY_TTL_S);
  assert.equal(KEY_TTL_S, 300);
  assert.match(body.description, /^vyre device [a-z0-9]+$/);
});

test("tailnet: no or malformed credential is not_set_up, and never echoes what the vault held", async t => {
  fakeApi(t);
  for (const raw of [null, "", "not json", JSON.stringify({ client_id: "x" })]) {
    const e = await tailscaleApi({ credential: async () => raw }).mintKey("abcdefghijklmnop").catch(x => x);
    assert.equal(e.code, "not_set_up", String(raw));
    if (raw) assert.ok(!e.message.includes(raw), "the credential is not in the message");
  }
  assert.throws(() => parseCredential("{}"), /tailscale-mint-oauth/);
});

test("tailnet: a refused mint says what the OAuth client needs; deleteNode treats a gone node as deleted", async t => {
  const seen = fakeApi(t, { "POST /api/v2/tailnet/-/keys": [403, {}], "DELETE /api/v2/device/nGONE1CNTRL": [404, {}], "DELETE /api/v2/device/nLIVE1CNTRL": [200, {}] });
  const api = tailscaleApi({ credential: async () => CRED });
  const e = await api.mintKey("abcdefghijklmnop").catch(x => x);
  assert.equal(e.code, "mint_failed");
  assert.match(e.message, /auth_keys for tag:vyre-device/);
  assert.equal(await api.deleteNode("nGONE1CNTRL"), true);
  assert.equal(await api.deleteNode("nLIVE1CNTRL"), true);
  assert.ok(seen.some(s => s.method === "DELETE" && s.url === "/api/v2/device/nLIVE1CNTRL"));
  assert.equal((await api.deleteNode("../../keys").catch(x => x)).code, "bad_input");
});

/** A fake tailscale that writes down each `up`: its argv, the key file's modes and content, and whether the key was in its env. */
function fakeTailscale(t, { state = "NeedsLogin", upCode = 0, status = null, statusCode = 0 } = {}) {
  const dir = tempHome(t);
  const log = path.join(dir, "log.jsonl");
  const bin = path.join(dir, "tailscale");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const [cmd, ...args] = process.argv.slice(2);
const joined = fs.existsSync(${JSON.stringify(path.join(dir, "joined"))});
if (cmd === "status" && !joined && ${JSON.stringify(status)} !== null) { process.stdout.write(${JSON.stringify(status)}); process.exit(${statusCode}); }
if (cmd === "status") {
  const running = joined || ${JSON.stringify(state)} === "Running";
  process.stdout.write(JSON.stringify({ BackendState: running ? "Running" : ${JSON.stringify(state)}, Self: running ? { ID: "nDESK1CNTRL", HostName: "alex-desktop" } : null }));
  process.exit(0);
}
if (cmd === "up") {
  const flag = args.find(a => a.startsWith("--auth-key=file:"));
  const file = flag ? flag.slice("--auth-key=file:".length) : null;
  const rec = { args, env: Object.values(process.env).some(v => String(v).includes("tskey-auth")) };
  if (file) { rec.key = fs.readFileSync(file, "utf8"); rec.fileMode = fs.statSync(file).mode & 0o777; rec.dirMode = fs.statSync(path.dirname(file)).mode & 0o777; rec.file = file; }
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(rec) + "\\n");
  if (${upCode} !== 0) { process.stderr.write("backend error: invalid key"); process.exit(${upCode}); }
  fs.writeFileSync(${JSON.stringify(path.join(dir, "joined"))}, "1");
  process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });
  const was = process.env.VYRE_TAILSCALE_BIN;
  process.env.VYRE_TAILSCALE_BIN = bin;
  t.after(() => { if (was === undefined) delete process.env.VYRE_TAILSCALE_BIN; else process.env.VYRE_TAILSCALE_BIN = was; });
  return { dir, ups: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l)) : [] };
}

test("tailnet: the key goes to tailscale up in a 0600 file in a 0700 dir, never argv or env, and the file is gone after", async t => {
  const ts = fakeTailscale(t);
  const tmp = tempHome(t);
  const r = await joinWithKey(KEY, { hostname: "alex-desktop", tmp });
  assert.deepEqual(r, { joined: true, stableId: "nDESK1CNTRL", node: "alex-desktop" });
  const [up] = ts.ups();
  assert.equal(up.key, KEY);
  assert.equal(up.fileMode, 0o600);
  assert.equal(up.dirMode, 0o700);
  assert.equal(up.env, false, "the key is not in the child's environment");
  assert.ok(!up.args.some(a => a.includes("tskey-")), "the key is not on the command line");
  assert.ok(up.args.includes(`--advertise-tags=${DEVICE_TAG}`));
  assert.ok(!fs.existsSync(up.file) && !fs.existsSync(path.dirname(up.file)), "the key file and its directory are removed");
  assert.deepEqual(fs.readdirSync(tmp), [], "nothing left in the temp dir");
});

test("tailnet: a failed tailscale up still removes the key file, and reports why without the key", async t => {
  const ts = fakeTailscale(t, { upCode: 1 });
  const tmp = tempHome(t);
  const r = await joinWithKey(KEY, { tmp });
  assert.equal(r.joined, false);
  assert.match(String(r.why), /invalid key/);
  assert.ok(!String(r.why).includes(KEY));
  assert.deepEqual(fs.readdirSync(tmp), []);
  assert.equal(ts.ups().length, 1, "no retry with the same key");
  assert.equal((await joinWithKey("not-a-key", { tmp })).joined, false);
  assert.equal(ts.ups().length, 1, "a malformed key never reaches tailscale");
});

test("tailnet: canJoin says not installed (with this OS's install line), or leaves a machine on its own tailnet alone", async t => {
  const none = await canJoin();
  assert.equal(none.ready, false, "under node --test with no fake there is no tailscale at all");
  assert.equal(/** @type {any} */ (none).why, "not_installed");
  assert.equal(/** @type {any} */ (none).install, installCommand());
  fakeTailscale(t, { state: "Running" });
  const own = await canJoin();
  assert.equal(/** @type {any} */ (own).why, "already_on_a_tailnet");
  for (const p of ["linux", "darwin", "win32"]) assert.equal(installCommand(p), namesInstall(p), p);
});

test("tailnet: canJoin fails closed: unreadable status, stopped-but-signed-in, or an expired node key is the person's own tailnet", async t => {
  const cases = [
    { status: "not json at all", statusCode: 1 },
    { status: "", statusCode: 0 },
    { status: JSON.stringify({ BackendState: "Stopped", Self: { ID: "nMINE1", HostName: "alex-mbp" } }) },
    { status: JSON.stringify({ BackendState: "NeedsLogin", Self: { ID: "nMINE1", HostName: "alex-mbp" } }) },
    { status: JSON.stringify({ BackendState: "Starting", Self: null }) },
  ];
  for (const c of cases) {
    fakeTailscale(t, c);
    const r = await canJoin();
    assert.equal(r.ready, false, c.status);
    assert.equal(/** @type {any} */ (r).why, "already_on_a_tailnet", c.status);
  }
  fakeTailscale(t, { status: JSON.stringify({ BackendState: "NoState" }) });
  assert.deepEqual(await canJoin(), { ready: true }, "a fresh install with no node yet");
});

test("tailnet: a signed-out tailscale is ready to join", async t => {
  fakeTailscale(t, { state: "NeedsLogin" });
  assert.deepEqual(await canJoin(), { ready: true });
});

// ---- the box and a desktop, end to end: a real vyred, the Node relay, the real relay/client ----

const lenient = {
  required: (tool, def, input) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
  verify: async ({ proof }) => (proof ? { ok: true, method: "passkey", keyId: "k1" } : { ok: false, message: "needs a person", methods: ["passkey"] }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
  summary: async () => "", covered: () => false, coverage: () => ({ covered: false, since: null, expires: null }),
  enrolled: /** @type {any[]} */ ([]), enroll(k) { this.enrolled.push(k); return { id: `kh${this.enrolled.length}`, kind: k.kind, name: k.name }; },
};
const PROOF = { proof: { method: "passkey", id: "x" } };
const MINTED = { "POST /api/v2/tailnet/-/keys": [200, { id: "k1", key: KEY, expires: new Date(Date.now() + 300_000).toISOString() }], "DELETE /api/v2/device/nDESK1CNTRL": [200, {}] };

async function box(t, { address = "https://alex.example.ts.net" } = {}) {
  const relay = createRelay();
  const url = await relay.listen();
  t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [],
    network: { name: "alex", ...(address ? { address } : {}) }, relay: { enabled: false, url }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ presence: lenient, root, log: () => {} });
  t.after(() => d.stop());
  return d;
}

/** A desktop Vyre pairs with the box as core/relay/redeem.js does, then keeps a channel open to it. */
async function desktop(t, d, { tailnet = true } = {}) {
  const minted = await d.registry.call("relay.pair.start", {}, "cli", PROOF);
  assert.ok(minted.data, JSON.stringify(minted.error));
  const url = minted.data.url;
  const root = tempHome(t);
  const paired = await redeem(url, { root, name: "alex's desktop", tailnet });
  const conn = connect({ relay: paired.relay, route: paired.route, box: paired.box, crypto: nodeCrypto(), keyStore: fileKeyStore(path.join(root, "relay-device", "key.json")) });
  t.after(() => conn.close());
  const askKey = async () => { const r = await conn.fetch(JOIN_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); return { status: r.status, body: /** @type {any} */ (await r.json()) }; };
  return { root, paired, conn, askKey };
}

test("tailnet: a desktop whose pairing asked to join gets one key over its own channel; nothing else gets one", async t => {
  const seen = fakeApi(t, MINTED, async () => CRED);
  const d = await box(t);
  const desk = await desktop(t, d);
  const got = await desk.askKey();
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.equal(got.body.data.authKey, KEY);
  assert.equal(got.body.data.device, desk.paired.device);
  assert.equal(got.body.data.address, "https://alex.example.ts.net");
  assert.equal(got.body.data.tag, DEVICE_TAG);
  assert.match(got.body.data.bindCode, /^[A-Za-z0-9_-]{20,}$/);
  assert.equal((await desk.askKey()).status, 429, "one key per few minutes per device");
  assert.equal(seen.filter(x => x.url === "/api/v2/tailnet/-/keys").length, 1);

  const phone = await desktop(t, d, { tailnet: false });
  const refused = await phone.askKey();
  assert.equal(refused.status, 403, "a pairing that did not ask (a phone) never gets a key");

  // Minting is not a tool: no registry name reaches it, from any caller.
  const tools = [...d.registry.tools.keys()];
  assert.ok(tools.length > 20, "the registry lists its tools");
  assert.ok(!tools.some(n => /tailnet\.key|mint/i.test(n)), tools.join(","));
  const viaRouter = await desk.conn.fetch("/v1/tools/relay.tailnet.key", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.notEqual(viaRouter.status, 200);
  assert.ok(!JSON.stringify(d.events.since(0, { limit: 1000 })).includes(KEY), "the key is in no event");
});

test("tailnet: whois's node binds to the desktop with its bind code, once; revoke deletes the node from the tailnet too", async t => {
  const seen = fakeApi(t, MINTED, async () => CRED);
  const d = await box(t);
  const desk = await desktop(t, d);
  const { bindCode, device } = (await desk.askKey()).body.data;
  const bind = (caller, code, stableId = "nDESK1CNTRL") => d.registry.call("relay.devices.bind", { stableId, node: "alex-desktop", device, code }, caller);
  assert.equal((await bind("module:other", bindCode)).error?.code, "denied", "only the tailnet listener binds");
  assert.equal((await bind("module:names", "wrong-code-wrong-code")).error?.code, "denied");
  const ok = await bind("module:names", bindCode);
  assert.deepEqual(ok.data, { device, node: "nDESK1CNTRL" });
  assert.equal((await bind("module:names", bindCode, "nOTHER1CNTRL")).error?.code, "denied", "the bind code is single use");
  assert.equal((await d.registry.call("relay.devices.tailnet", { stableId: "nDESK1CNTRL" }, "module:names")).data.device, device);
  assert.equal((await d.registry.call("relay.devices.tailnet", { stableId: "nOTHER1CNTRL" }, "module:names")).data.device, null);
  assert.equal((await desk.askKey()).status, 409, "already on the tailnet: no second key");

  const removed = await d.registry.call("relay.devices.remove", { id: device }, "cli", PROOF);
  assert.ok(removed.data, JSON.stringify(removed.error));
  assert.equal((await d.registry.call("relay.devices.tailnet", { stableId: "nDESK1CNTRL" }, "module:names")).data.device, null, "admission fails closed at once");
  for (let i = 0; i < 50 && !seen.some(x => x.method === "DELETE"); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(seen.some(x => x.method === "DELETE" && x.url === "/api/v2/device/nDESK1CNTRL"), "and the node is deleted from the tailnet");
});

test("tailnet: no minting credential, or no tailnet address, leaves the desktop on the relay with a clear reason", async t => {
  fakeApi(t, MINTED, async () => null);
  const d = await box(t);
  const desk = await desktop(t, d);
  const r = await desk.askKey();
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "not_set_up");

  const bare = await box(t, { address: "" });
  const other = await desktop(t, bare);
  const n = await other.askKey();
  assert.equal(n.body.error.code, "no_tailnet");
});

test("tailnet: a Mac box never mints, before vyre-core", async t => {
  fakeApi(t, MINTED, async () => CRED);
  const real = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(process, "platform"));
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", real));
  const d = await box(t);
  Object.defineProperty(process, "platform", real);
  const desk = await desktop(t, d);
  const r = await desk.askKey();
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, "not_available_here");
});

test("tailnet: desktopJoin asks, joins with the key in a file, binds through the box, and remembers it", async t => {
  fakeApi(t, MINTED, async () => CRED);
  const d = await box(t);
  const url = (await d.registry.call("relay.pair.start", {}, "cli", PROOF)).data.url;
  const root = tempHome(t);
  await redeem(url, { root, name: "alex's desktop", tailnet: true });
  assert.equal(pairedBox(root).route, (await d.registry.call("relay.status", {}, "cli")).data.route);

  // Not installed: stays on the relay, with this OS's install line.
  const none = await desktopJoin({ root });
  assert.equal(none.state, "relay_only");
  assert.equal(none.install, installCommand());

  const ts = fakeTailscale(t);
  /** @type {string[]} */
  const asked = [];
  // The box's names listener, faked: whois says nDESK1CNTRL, and it calls relay.devices.bind as itself.
  const listener = /** @type {any} */ (async (u, init) => {
    asked.push(u);
    const b = JSON.parse(init.body);
    const r = await d.registry.call("relay.devices.bind", { stableId: "nDESK1CNTRL", node: "alex-desktop", device: b.device, code: b.code }, "module:names");
    return { ok: !r.error, status: r.error ? 403 : 200, json: async () => r };
  });
  const r = await desktopJoin({ root, fetch: listener, wait: async () => {} });
  assert.equal(r.state, "joined", JSON.stringify(r));
  assert.deepEqual(asked, ["https://alex.example.ts.net/v1/tailnet/bind"]);
  const [up] = ts.ups();
  assert.ok(!up.args.some(a => a.includes("tskey-")));
  assert.equal(pairedBox(root).tailnet.state, "joined");
  assert.ok(!fs.readFileSync(path.join(root, "relay-device", "box.json"), "utf8").includes(KEY), "the key is never written down");
  assert.equal((await d.registry.call("relay.devices.tailnet", { stableId: "nDESK1CNTRL" }, "module:names")).data.device, pairedBox(root).device);
  assert.equal((await desktopJoin({ root })).state, "joined", "a joined desktop does not ask again");
  assert.equal(ts.ups().length, 1);
});

test("tailnet: a failed node delete never lets the old node back in, even when the device pairs again; the delete is retried", async t => {
  let deleteOk = false;
  /** @type {string[]} */
  const deletes = [];
  const fetch = /** @type {any} */ (async (url, init = {}) => {
    const u = new URL(url);
    const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (u.pathname === "/api/v2/oauth/token") return reply(200, { access_token: "tok-fake" });
    if (u.pathname === "/api/v2/tailnet/-/keys") return reply(200, { key: KEY, expires: new Date(Date.now() + 300_000).toISOString() });
    if (init.method === "DELETE") { deletes.push(u.pathname); return reply(deleteOk ? 200 : 500, {}); }
    if (u.pathname === "/api/v2/tailnet/-/devices") return reply(200, { devices: [{ nodeId: "nDESK1CNTRL" }] });
    return reply(404, {});
  });
  t.after(useTailscaleApi({ fetch, base: "https://api.example.invalid", credential: async () => CRED }));
  const d = await box(t);
  const desk = await desktop(t, d);
  const { bindCode, device } = (await desk.askKey()).body.data;
  assert.ok((await d.registry.call("relay.devices.bind", { stableId: "nDESK1CNTRL", node: "alex-desktop", device, code: bindCode }, "module:names")).data);
  assert.ok((await d.registry.call("relay.devices.remove", { id: device }, "cli", PROOF)).data);
  for (let i = 0; i < 50 && !deletes.length; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(deletes.length, 1, "the delete was tried, and Tailscale refused it");
  for (let i = 0; i < 50 && !d.events.since(0, { limit: 1000 }).some(e => e.type === "tailnet.revoke-failed"); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(d.events.since(0, { limit: 1000 }).some(e => e.type === "tailnet.revoke-failed"), "and says so");

  // The same desktop pairs again (same key, same device id): its old node is not admitted.
  const url = (await d.registry.call("relay.pair.start", {}, "cli", PROOF)).data.url;
  const again = await redeem(url, { root: desk.root, name: "alex's desktop", tailnet: true });
  assert.equal(again.device, device, "the same device id");
  assert.equal((await d.registry.call("relay.devices.tailnet", { stableId: "nDESK1CNTRL" }, "module:names")).data.device, null, "the old node needs a new bind");

  // The device list retries the delete, and a success clears it.
  deleteOk = true;
  await d.registry.call("relay.devices.list", {}, "cli");
  for (let i = 0; i < 50 && deletes.length < 2; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(deletes, ["/api/v2/device/nDESK1CNTRL", "/api/v2/device/nDESK1CNTRL"]);
  await new Promise(r => setTimeout(r, 20));
  await d.registry.call("relay.devices.list", {}, "cli");
  await new Promise(r => setTimeout(r, 50));
  assert.equal(deletes.length, 2, "once deleted, never asked again");
});
