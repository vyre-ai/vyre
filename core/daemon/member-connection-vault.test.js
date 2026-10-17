// @ts-check
// The Vault's half of a member's app connection, on a REAL daemon with the kernel on (the rig of two-member-connections.test.js), for the release conditions that are the Vault's:
//   15  a locked member's connection still works for the hub (the sealed connection key), and that sealed key opens connection items and NOTHING else: not an ordinary item, not ck.json;
//   10  an unshare, and the deletion of a connection, discard what the grantee left waiting at the Gate (mcp.sweep), at once.
// The paste-a-token path of a test preset (no vendor, no browser). Written without a run: it is seen to run on CI first.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";

// Presets for fakes on this machine are honoured only under this switch (production reads the shipped catalog).
process.env.VYRE_CONNECTORS_TEST_PRESETS = "1";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "./index.js";
import { tempHome, present } from "../../test/helpers.js";
import { startFakeMcpHttp } from "../mcp/testing/fake-mcp.js";
import { allowLoopbackForTests } from "../../lib/http.js";
import { PeopleVaults } from "../vault/people.js";
import { openConnectionKey } from "../vault/people-seal.js";
import { openItemV2 } from "../vault/crypto.js";
allowLoopbackForTests();

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab", CY = "per_" + "defghijklmnopqrstuvwxyzabc";
const BEN_TOKEN = "ben-connection-token-0123456789", CY_TOKEN = "cy-connection-token-0123456789";
const PW = "a long master password for the test";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

async function rig(t) {
  const mcp = await startFakeMcpHttp(t, { requireAuth: h => h === `Bearer ${BEN_TOKEN}` || h === `Bearer ${CY_TOKEN}` });
  const root = tempHome(t);
  const preset = { id: "tokvendor", label: "Token Vendor", group: "work", url: mcp.url, transport: "http", who: "Anyone.", evidence: "docs", prefer: "token", oauth: { client: "dcr" }, token: { label: "Token", help: "Made up." } };
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" }, connectors: { presets: [preset] } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const chain = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  for (const p of [BEN, CY]) await K.gateway.grants.setRole(chain(OWNER), { person: p, role: "member" }, { presence: proof() });
  const tok = async (/** @type {string} */ p) => (await K.surfaces.open(chain(p), {})).token;
  const tokens = { owner: await tok(OWNER), ben: await tok(BEN), cy: await tok(CY) };
  const who = { owner: OWNER, ben: BEN, cy: CY };
  /** a person's own surface: the person is the kernel's, the input names nobody */
  const as = (/** @type {"owner"|"ben"|"cy"} */ w, /** @type {string} */ tool, /** @type {any} */ input = {}) =>
    d.registry.call(tool, input, w === "owner" ? "cli" : (tool.startsWith("mcp.") ? "module:connectors" : "device:abcdefghijklmnop"), { token: tokens[w], ...(w === "owner" ? {} : { person: { id: "ps-" + w, kind: "passkey" } }) });
  /** a call carrying a token the kernel never issued */
  const forged = (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "device:abcdefghijklmnop", { token: "forged-token-that-the-kernel-never-issued", person: { id: "ps-ben", kind: "passkey" } });
  /** Ben's assistant: an agent in Ben's turn */
  const juno = async () => (await d.registry.call("agents.create", { name: "juno", kind: "agent" }, "device:abcdefghijklmnop", { token: tokens.ben, person: { id: "ps-ben", kind: "passkey" } })).data.uid;
  return { d, K, mcp, root, as, forged, juno, who, tok, chain };
}

/** The first file with this name under a folder, or "". */
const find = (/** @type {string} */ dir, /** @type {string} */ name) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) { const r = find(f, name); if (r) return r; } else if (e.name === name) return f; } return ""; };
/** Every file under a folder, as one string (utf8, lossy), to look for a value that must not be there. */
const diskText = (/** @type {string} */ dir) => { let out = ""; const walk = (/** @type {string} */ p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else { try { out += fs.readFileSync(f).toString("utf8"); } catch { /* unreadable */ } } } }; walk(dir); return out; };

test("a locked member's connection still works for the hub, and the server's sealed key opens connection items and nothing else", { timeout: 280_000 }, async t => {
  const { d, mcp, root, as } = await rig(t);
  const step = (/** @type {string} */ name, /** @type {any} */ ok) => assert.ok(ok, name);
  step("Ben makes a vault", (await as("ben", "vault.me.account.create", { password: PW })).data);
  step("an ordinary item of his", (await as("ben", "vault.me.put", { name: "diary", kind: "note", fields: { value: "ORDINARY-NOTE-0001" } })).data);
  const conn = await as("ben", "connectors.connect", { preset: "tokvendor", token: BEN_TOKEN });
  step("Ben connects: " + JSON.stringify(conn.error || ""), conn.data && conn.data.step === "connected");
  const benRow = ((await as("ben", "mcp.servers")).data || []).find((/** @type {any} */ s) => s.owner === BEN);
  step("his row", benRow);
  // nobody is unlocked now: the person locks her own vault
  step("Ben locks his vault", (await as("ben", "vault.me.account.lock")).data);
  step("locked: his own items are not readable", (await as("ben", "vault.me.get", { name: "diary" })).error);
  const tool = ((await as("ben", "mcp.tools", {})).data || []).find((/** @type {any} */ x) => x.server === benRow.name && !x.outward);
  step("the hub still lists his connection's tools", tool);
  const before = mcp.requests.filter((/** @type {any} */ r) => r.authorization === `Bearer ${BEN_TOKEN}`).length;
  const ran = await as("ben", "mcp.call", { server: benRow.name, tool: tool.tool, arguments: {} });
  step("a call runs while he is locked: " + JSON.stringify(ran.error || ""), !ran.error);
  step("it reached the server with his token", mcp.requests.filter((/** @type {any} */ r) => r.authorization === `Bearer ${BEN_TOKEN}`).length > before);

  // what the server holds opens connection items and nothing else
  const ck = find(root, "ck.json");
  step("his connection key file is there", ck);
  const sealRoot = path.dirname(path.dirname(path.dirname(path.dirname(ck))));
  const pv = new PeopleVaults({ dir: path.join(sealRoot, "vault-people"), sealRoot });
  const sealed = openConnectionKey(sealRoot, BEN);
  step("the server holds a connection key for him", sealed);
  const folder = path.dirname(ck);
  const files = (/** @type {string} */ d2) => (fs.existsSync(d2) ? fs.readdirSync(d2).filter(f => f.endsWith(".json")) : []);
  const open = (/** @type {any} */ k, /** @type {string} */ dir, /** @type {any} */ at, /** @type {string} */ f) => openItemV2(k, at(BEN, f.slice(0, -5)), JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  const [connFile] = files(path.join(folder, "conn-items")), [ordFile] = files(path.join(folder, "me-items"));
  step("a connection item is there", connFile); step("an ordinary item is there", ordFile);
  step("the sealed key opens the connection item", open(sealed, path.join(folder, "conn-items"), pv.atConn.bind(pv), connFile).fields);
  assert.throws(() => open(sealed, path.join(folder, "me-items"), pv.at.bind(pv), ordFile), "the sealed key cannot open an ordinary item");
  assert.throws(() => openItemV2(sealed, pv.at(BEN, "ck"), JSON.parse(fs.readFileSync(ck, "utf8"))), "nor the file that holds the key");
  // and nothing of his is on disk in the clear
  const disk = diskText(root);
  step("his token and his note are not on the disk in the clear", !disk.includes(BEN_TOKEN) && !disk.includes("ORDINARY-NOTE-0001"));
});

test("an unshare, the deletion of a connection and the maker leaving the Space discard what the grantee left waiting at the Gate, at once", { timeout: 280_000 }, async t => {
  const { as, d } = await rig(t);
  const step = (/** @type {string} */ name, /** @type {any} */ ok) => assert.ok(ok, name);
  step("Ben makes a vault", (await as("ben", "vault.me.account.create", { password: PW })).data);
  const conn = await as("ben", "connectors.connect", { preset: "tokvendor", token: BEN_TOKEN });
  step("Ben connects", conn.data && conn.data.step === "connected");
  const item = ((await as("ben", "vault.me.list")).data.items || []).find((/** @type {any} */ i) => i.kind === "connection");
  step("his connection item", item);
  const benRow = ((await as("ben", "mcp.servers")).data || []).find((/** @type {any} */ s) => s.owner === BEN);
  // what the hub's own sender (mcp:<row>) is holding at the Gate: the Gate's gate.held-of, asked as the module that offered it, answers { id, requester } for each
  const heldOf = async () => ((await d.registry.call("gate.held-of", { via: `mcp:${benRow.name}` }, "module:mcp", {})).data || []);
  const send = () => as("cy", "mcp.call", { server: benRow.name, tool: "send_message", arguments: { to: "x@example.test", text: "hello" } });

  // shared at Fill in, Cy's outward call waits at the Gate; taking the share back discards it
  step("Ben shares it with Cy at Fill in", (await as("ben", "vault.me.connection.share", { name: item.name, kind: "person", subject: CY, level: "use" })).data);
  const first = await send();
  step("Cy's send is held, not sent: " + JSON.stringify(first.error || first.data), first.data && first.data.held);
  const waiting = await heldOf();
  step("it waits at the Gate, asked by Cy (so the check can fail)", waiting.length === 1 && waiting[0].requester === CY);
  step("Ben takes the share back", (await as("ben", "vault.me.connection.share", { name: item.name, kind: "person", subject: CY, level: null })).data);
  step("what Cy left waiting is gone at once", (await heldOf()).length === 0);
  step("and her next call is refused", (await send()).error);

  // shared again, held again; deleting the connection discards it too
  step("shared again", (await as("ben", "vault.me.connection.share", { name: item.name, kind: "person", subject: CY, level: "use" })).data);
  step("Cy's send is held again", (await send()).data?.held);
  step("Ben deletes the connection", (await as("ben", "vault.me.remove", { name: item.name })).data);
  step("what was waiting is gone", (await heldOf()).length === 0);
  step("the share went with it: her call is refused", (await send()).error);
});

test("the maker leaving the Space ends what she shared and discards what was waiting for it", { timeout: 280_000 }, async t => {
  const { as, d, K } = await rig(t);
  const step = (/** @type {string} */ name, /** @type {any} */ ok) => assert.ok(ok, name);
  step("Ben makes a vault", (await as("ben", "vault.me.account.create", { password: PW })).data);
  step("Ben connects", (await as("ben", "connectors.connect", { preset: "tokvendor", token: BEN_TOKEN })).data?.step === "connected");
  const item = ((await as("ben", "vault.me.list")).data.items || []).find((/** @type {any} */ i) => i.kind === "connection");
  const benRow = ((await as("ben", "mcp.servers")).data || []).find((/** @type {any} */ s) => s.owner === BEN);
  const heldOf = async () => ((await d.registry.call("gate.held-of", { via: `mcp:${benRow.name}` }, "module:mcp", {})).data || []);
  step("Ben shares it with Cy at Fill in", (await as("ben", "vault.me.connection.share", { name: item.name, kind: "person", subject: CY, level: "use" })).data);
  const sent = await as("cy", "mcp.call", { server: benRow.name, tool: "send_message", arguments: { to: "x@example.test", text: "hello" } });
  step("Cy's send is held: " + JSON.stringify(sent.error || sent.data), sent.data && sent.data.held);
  step("it waits at the Gate, asked by Cy", (await heldOf()).some((/** @type {any} */ h) => h.requester === CY));
  const gone = await as("owner", "spaces.members.remove", { space: K.id.space, person: BEN });
  step("the owner removes Ben from the Space: " + JSON.stringify(gone.error || ""), !gone.error);
  await new Promise(r => setTimeout(r, 500));
  step("what was waiting for his connection is gone", (await heldOf()).length === 0);
  step("Cy's next call is refused", (await as("cy", "mcp.call", { server: benRow.name, tool: "send_message", arguments: { to: "x@example.test", text: "again" } })).error);
});
