// @ts-check
// Connections that belong to people, through the production path: a real vyred with the kernel on, a Space owner and two members (Ben and Cy), each call carrying the caller's own session token the way the app
// sends it. What these prove: each person lists, and sees connected marks for, only their own connections; a member's disconnect removes her connection and her hub row and never the owner's or another member's of
// the same name; one member cannot remove or approve the changed tool text of another's row, nor can the Space owner approve a member's; a forged token is refused on each of the six connect tools; and Ben's
// assistant reads Ben's list and cannot connect or disconnect. The rows are seeded in the module's tables: the sign-in itself is covered with a fake vendor in lib/connectors/connect.test.js.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { personKey } from "../mcp/hub.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const CY = "per_" + "defghijklmnopqrstuvwxyzabc";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const URL1 = "https://mcp.example.test/mcp";
const SIX = ["connectors.catalog", "connectors.connect", "connectors.connect.finish", "connectors.connect.cancel", "connectors.disconnect", "connectors.list"];

async function world(/** @type {import("node:test").TestContext} */ t) {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  for (const p of [BEN, CY]) await K.gateway.grants.setRole(ownerChain, { person: p, role: "member" }, { presence: proof() });
  const chainOf = (/** @type {string} */ p, /** @type {string} */ id) => K.chains.fromFacts({ kind: "device", device_key_id: id, person: p, path: "relay" });
  const benChain = chainOf(BEN, "d-ben"), cyChain = chainOf(CY, "d-cy");
  const tokenOf = async (/** @type {any} */ c, /** @type {any} */ o = {}) => (await K.surfaces.open(c, o)).token;
  const tokens = { owner: await tokenOf(ownerChain), ben: await tokenOf(benChain), cy: await tokenOf(cyChain), kit: await tokenOf(benChain, { agent: "kit", thread: "t-1" }) };
  /** The app: a person's surface with the person's own token. */
  const as = (/** @type {"owner" | "ben" | "cy"} */ who, /** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, who === "owner" ? "cli" : "deck", { token: tokens[who] });
  const forged = (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "deck", { token: "forged-token-that-no-session-made" });
  const kit = (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "mcp:agent:kit", { token: tokens.kit, thread: "t-1", agent: "kit" });
  const db = d.registry.deps.db;
  const conn = (/** @type {string} */ name, /** @type {string} */ person, /** @type {string} */ label) => db.prepare("INSERT INTO connectors_connections (name, person, preset, item, mode, label, created) VALUES (?,?,?,?,?,?,?)").run(name, person, "notion", `${name}-${person.slice(4, 8) || "own"}-auth`, "oauth", label, 1);
  const hub = (/** @type {string} */ name, /** @type {string} */ owner, /** @type {string} */ label) => db.prepare("INSERT INTO mcp_servers (name, transport, url, auth, scope, tools, added, updated, owner, connection, label) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(name, "http", URL1, JSON.stringify(owner ? { type: "oauth", connection: `${label}-${owner.slice(4, 8)}-auth` } : { type: "none" }), '{"projects":"*","agents":"*"}', "{}", 1, 1, owner || null, owner ? `${label}-${owner.slice(4, 8)}-auth` : null, owner ? label : null);
  const hubNames = () => db.prepare("SELECT name FROM mcp_servers ORDER BY name").all().map((/** @type {any} */ r) => String(r.name));
  const connNames = () => db.prepare("SELECT person, name FROM connectors_connections ORDER BY person, name").all().map((/** @type {any} */ r) => `${r.person || "owner"}:${r.name}`);
  return { d, OWNER, as, forged, kit, conn, hub, hubNames, connNames, db };
}

/** The owner, Ben and Cy each connected "notion"; Cy also connected "linear". */
function seed(/** @type {Awaited<ReturnType<typeof world>>} */ w) {
  w.conn("notion", "", "owner's"); w.conn("notion", BEN, "ben's"); w.conn("notion", CY, "cy's"); w.conn("linear", CY, "cy's linear");
  w.hub("notion", "", ""); w.hub(personKey("notion", BEN), BEN, "notion"); w.hub(personKey("notion", CY), CY, "notion"); w.hub(personKey("linear", CY), CY, "linear");
}

test("members list and see connected marks for their own connections only", { timeout: 150_000 }, async t => {
  const w = await world(t); seed(w);
  // the list names each connection by its short name and the app's label; which connection is whose is the name's and the person's
  const labels = async (/** @type {any} */ r) => (r.data || []).map((/** @type {any} */ c) => c.name).sort();
  assert.deepEqual(await labels(await w.as("ben", "connectors.list")), ["notion"], JSON.stringify((await w.as("ben", "connectors.list")).error));
  assert.deepEqual(await labels(await w.as("cy", "connectors.list")), ["linear", "notion"]);
  assert.deepEqual(await labels(await w.as("owner", "connectors.list")), ["notion"], "the owner's list does not show a member's");
  const marks = async (/** @type {any} */ r, /** @type {string} */ id) => ((r.data.presets.find((/** @type {any} */ p) => p.id === id) || {}).connected || []).map((/** @type {any} */ c) => c.label).sort();
  assert.deepEqual(await marks(await w.as("ben", "connectors.catalog"), "notion"), ["ben's"]);
  assert.deepEqual(await marks(await w.as("cy", "connectors.catalog"), "notion"), ["cy's", "cy's linear"], "(the seed records both of Cy's under the notion preset)");
  assert.deepEqual(await marks(await w.as("owner", "connectors.catalog"), "notion"), ["owner's"]);
});

test("a member's disconnect removes her connection and her hub row, and never the owner's or another member's of the same name", { timeout: 150_000 }, async t => {
  const w = await world(t); seed(w);
  const r = await w.as("ben", "connectors.disconnect", { name: "notion" });
  assert.deepEqual({ name: r.data?.name, removed: r.data?.removed, revoked: r.data?.revoked }, { name: "notion", removed: true, revoked: false }, JSON.stringify(r.error));   // no vault item behind this seeded row: the vendor could not be told, and the answer says so
  assert.deepEqual(w.connNames(), ["cy:linear", "cy:notion", "owner:notion"].map(x => x.replace(/^cy:/, `${CY}:`)).sort(), "only Ben's connection went");
  assert.deepEqual(w.hubNames(), ["notion", personKey("linear", CY), personKey("notion", CY)].sort(), "only Ben's hub row went: the owner's \"notion\" and Cy's stay");
  // Ben has nothing left to disconnect; the owner's connection of the same name is not his to remove
  const again = await w.as("ben", "connectors.disconnect", { name: "notion" });
  assert.equal(again.error?.code, "not_found", JSON.stringify(again));
  assert.equal(w.connNames().length, 3);
});

test("one member cannot remove or approve another's row, and the owner cannot approve a member's", { timeout: 150_000 }, async t => {
  const w = await world(t); seed(w);
  const benKey = personKey("notion", BEN);
  // A member does not remove a hub row directly at all (the door keeps mcp.remove to the owner); through her own disconnect only her rows are reachable. Cy naming Ben's key or label gets nothing.
  for (const name of [benKey, "notion"]) assert.ok((await w.as("cy", "mcp.remove", { name })).error, `mcp.remove ${name} ran for a member`);
  assert.ok(w.hubNames().includes(benKey) && w.hubNames().includes(personKey("notion", CY)), "no row was removed");
  // Ben's row is held for changed tool text
  const seen = "b".repeat(64);
  w.db.prepare("UPDATE mcp_servers SET tools_pin = ?, pin_seen = ?, tools_seen = '[]', tools_cache = '[]' WHERE name = ?").run("a".repeat(64), seen, benKey);
  assert.equal((await w.as("cy", "mcp.repin", { name: "notion", seen })).error?.code, "bad_state", "by label she reaches her own \"notion\", which is not held; Ben's is not reachable by that name");
  assert.equal((await w.as("cy", "mcp.repin", { name: benKey, seen })).error?.code, "not_found");
  const o = await w.as("owner", "mcp.repin", { name: benKey, seen });
  assert.equal(o.error?.code, "denied", "the owner is refused a member's row: " + JSON.stringify(o));
  assert.ok(w.db.prepare("SELECT pin_seen FROM mcp_servers WHERE name = ?").get(benKey).pin_seen, "still held");
  const ben = await w.as("ben", "mcp.repin", { name: "notion", seen });
  assert.equal(ben.data?.pin?.state, "pinned", "Ben approves his own: " + JSON.stringify(ben.error));
});

test("a forged token is refused on each of the six connect tools and never served as the owner's", { timeout: 150_000 }, async t => {
  const w = await world(t); seed(w);
  for (const tool of SIX) {
    const r = await w.forged(tool, { preset: "notion", id: "x", url: "https://x.example.test/", name: "notion" });
    assert.ok(r.error, `${tool} ran for a forged token: ${JSON.stringify(r).slice(0, 160)}`);
    assert.ok(!r.data, `${tool} returned data`);
  }
  assert.equal(w.connNames().length, 4, "nothing was removed");
});

test("Ben's assistant reads Ben's list and cannot connect or disconnect", { timeout: 150_000 }, async t => {
  const w = await world(t); seed(w);
  const list = await w.kit("connectors.list");
  assert.deepEqual((list.data || []).map((/** @type {any} */ c) => c.name), ["notion"], JSON.stringify(list.error));
  const cat = await w.kit("connectors.catalog");
  assert.deepEqual(((cat.data?.presets || []).find((/** @type {any} */ p) => p.id === "notion") || {}).connected?.map((/** @type {any} */ c) => c.label), ["ben's"]);
  for (const tool of ["connectors.connect", "connectors.connect.finish", "connectors.connect.cancel", "connectors.disconnect"]) {
    const r = await w.kit(tool, { preset: "notion", id: "x", url: "https://x.example.test/", name: "notion" });
    assert.ok(r.error, `${tool} ran for an assistant`);
  }
  assert.equal(w.connNames().length, 4, "nothing was removed");
});
