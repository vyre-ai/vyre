// @ts-check
// The hub and a person's own app connection, on a REAL daemon with the kernel on, against a fake MCP server, written to the recipe of flows-mcp-member.test.js (member session tokens on the registry's calls). It runs on CI.
// The connector tools themselves (list, disconnect, finish, forged tokens, the assistant's reads) are covered by core/connectors/member.test.js; this file does not repeat them. It covers what only the hub and the
// Vault can show:
//   C3         A's call to A's connection runs; B's, the owner's, an assistant's and a forged token's are refused, and a refused call never reaches the server with A's token
//   member tools  vault6's member-scoped mcp.update, remove, test and restart reach only the maker's own row; another member and the owner are refused; Ben's assistant cannot remove, update, test or restart Ben's row
// Everything uses the paste-a-token path of a test preset (no vendor, no browser).
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

test("two members' own app connections: each is used, listed and removed by its maker alone; the owner, the other member, an assistant and a forged token reach none of it", { timeout: 280_000 }, async t => {
  const { d, K, mcp, as, forged, juno, chain } = await rig(t);
  const step = (/** @type {string} */ name, /** @type {any} */ ok) => assert.ok(ok, name);

  // ---- each member makes their own vault and connects the same app with their own token
  for (const w of /** @type {const} */ (["ben", "cy"])) step(`${w} makes a vault`, (await as(w, "vault.me.account.create", { password: PW })).data);
  const benConn = await as("ben", "connectors.connect", { preset: "tokvendor", token: BEN_TOKEN });
  step("Ben connects: " + JSON.stringify(benConn.error || benConn.data), benConn.data && benConn.data.step === "connected");
  const cyConn = await as("cy", "connectors.connect", { preset: "tokvendor", token: CY_TOKEN });
  step("Cy connects: " + JSON.stringify(cyConn.error || cyConn.data), cyConn.data && cyConn.data.step === "connected");

  // ---- the hub rows: each is visible to its maker only (C3)
  const rowsOf = async (/** @type {"owner"|"ben"|"cy"} */ w) => ((await as(w, "mcp.servers")).data || []);
  const benRow = (await rowsOf("ben")).find((/** @type {any} */ s) => s.owner === BEN), cyRow = (await rowsOf("cy")).find((/** @type {any} */ s) => s.owner === CY);
  step("Ben sees his own row", benRow); step("Cy sees her own row", cyRow);
  step("the two rows have two keys", benRow.name !== cyRow.name);
  step("Ben sees none of Cy's", !(await rowsOf("ben")).some((/** @type {any} */ s) => s.owner === CY));
  step("Cy sees none of Ben's", !(await rowsOf("cy")).some((/** @type {any} */ s) => s.owner === BEN));
  step("the owner sees neither", !(await rowsOf("owner")).some((/** @type {any} */ s) => s.owner));

  // ---- C3: the call itself. A's call to A's connection runs; B's, the owner's and a forged token's are refused
  const toolsAns = await as("ben", "mcp.tools", {}); const tools = toolsAns.data;
  step("Ben's connection lists tools through the hub: " + JSON.stringify(toolsAns).slice(0, 300), Array.isArray(tools) && tools.some((/** @type {any} */ x) => x.server === benRow.name));
  const tool = tools.find((/** @type {any} */ x) => x.server === benRow.name && !x.outward);
  step("it has a read tool", tool);
  const run = (/** @type {"owner"|"ben"|"cy"} */ w, /** @type {string} */ server) => as(w, "mcp.call", { server, tool: tool.tool, arguments: {} });
  const ok = await run("ben", benRow.name);
  step("Ben's call to Ben's connection runs: " + JSON.stringify(ok.error || ""), !ok.error);
  step("it reached the server with Ben's token", mcp.requests.some((/** @type {any} */ r) => r.authorization === `Bearer ${BEN_TOKEN}`));
  const before = mcp.requests.filter((/** @type {any} */ r) => r.authorization === `Bearer ${BEN_TOKEN}`).length;
  for (const [w, label] of /** @type {[any, string][]} */ ([["cy", "Cy"], ["owner", "the owner"]])) {
    const r = await run(w, benRow.name);
    step(`${label}'s call to Ben's connection is refused`, r.error);
  }
  step("a forged token's call is refused", (await forged("mcp.call", { server: benRow.name, tool: tool.tool, arguments: {} })).error);
  step("the refused calls never reached the server with Ben's token", mcp.requests.filter((/** @type {any} */ r) => r.authorization === `Bearer ${BEN_TOKEN}`).length === before);
  step("Ben's call to Cy's connection is refused", (await run("ben", cyRow.name)).error);
  step("Cy's own call runs", !(await run("cy", cyRow.name)).error);

  // ---- one member cannot repin, test, restart, update or remove another's; the owner cannot repin a member's
  for (const [w, label] of /** @type {[any, string][]} */ ([["cy", "Cy"], ["owner", "the owner"]])) {
    step(`${label} cannot repin Ben's`, (await as(w, "mcp.repin", { name: benRow.name, seen: "0".repeat(64) })).error);
    step(`${label} cannot update Ben's`, (await as(w, "mcp.update", { name: benRow.name, idle: 60 })).error);
    step(`${label} cannot restart Ben's`, (await as(w, "mcp.restart", { name: benRow.name })).error);
    step(`${label} cannot test Ben's`, (await as(w, "mcp.test", { name: benRow.name })).error);
    step(`${label} cannot remove Ben's`, (await as(w, "mcp.remove", { name: benRow.name })).error);
  }
  step("Ben's row is still there", (await rowsOf("ben")).some((/** @type {any} */ s) => s.name === benRow.name));
  const benTest = await as("ben", "mcp.test", { name: benRow.label }); step("Ben can test his own: " + JSON.stringify(benTest).slice(0, 300), !benTest.error);
  step("Ben can restart his own", !(await as("ben", "mcp.restart", { name: benRow.label })).error);

  // ---- Ben's assistant (an agent in Ben's turn) is not Ben: it cannot remove, update, test or restart his connection, and the connection is still there afterwards
  const uid = await juno();
  const assistant = async (/** @type {string} */ tool2, /** @type {any} */ input = {}) => d.registry.call(tool2, input, "mcp:agent:juno", { token: (await K.surfaces.open(chain(BEN), { agent: uid, session: "s-juno-ben", thread: "t-juno-ben" })).token, thread: "t-juno-ben", agent: "juno" });
  step("the assistant cannot remove Ben's connection", (await assistant("mcp.remove", { name: benRow.name })).error);
  step("nor update it", (await assistant("mcp.update", { name: benRow.name, idle: 60 })).error);
  step("nor test it", (await assistant("mcp.test", { name: benRow.name })).error);
  step("nor restart it", (await assistant("mcp.restart", { name: benRow.name })).error);
  step("nor repin it", (await assistant("mcp.repin", { name: benRow.name, seen: "0".repeat(64) })).error);
  step("Ben's connection is still there and still runs", (await rowsOf("ben")).some((/** @type {any} */ s) => s.name === benRow.name) && !(await run("ben", benRow.name)).error);

  // ---- the maker removes his own; it is gone for him and untouched for Cy
  const removed = await as("ben", "mcp.remove", { name: benRow.label });
  step("Ben removes his own connection: " + JSON.stringify(removed.error || ""), !removed.error);
  step("his row is gone", !(await rowsOf("ben")).some((/** @type {any} */ s) => s.name === benRow.name));
  step("Cy's row and call are untouched", (await rowsOf("cy")).some((/** @type {any} */ s) => s.name === cyRow.name) && !(await run("cy", cyRow.name)).error);
});
