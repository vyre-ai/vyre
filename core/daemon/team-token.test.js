// @ts-check
// A model running a team chat's turn holds a session its TEAM Space's own kernel opened. The daemon's edge checks that token with that Space's Surfaces door (never the home's, never on the body's say-so), and a tool
// that takes a `space` acts in the token's Space when the model names none: so the model's tools reach the team's records as the member who spoke, and only the team's. A forged token, a token of the home,
// a token for another Space and a token naming another Space in the input are refused. Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { boot } from "../sessions/testing/boot.js";
import { call } from "./client.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const OWNER = "per_" + "abcdefghijklmnopqrstuvwxyz", ANA = "per_" + "bcdefghijklmnopqrstuvwxyza";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

test("a team session token passes the daemon's edge and a tool acts in the team Space as that member; other tokens do not", { timeout: 120_000 }, async t => {
  const w = await boot(t, { driver: "cli", kernel: true });
  const firm = await w.d.kernel.spaces.host({ owner: OWNER, name: "Harlow Legal" });
  const other = await w.d.kernel.spaces.host({ owner: OWNER, name: "Other Firm" });
  const owner = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await firm.gateway.grants.setRole(owner, { person: ANA, role: "member" }, { presence: proof() });
  const ana = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "vyred", person: ANA, path: "direct" });
  const team = (await firm.kernel.surfaces.open(ana, {})).token;
  const home = (await w.d.kernel.surfaces.open(w.d.kernel.chains.fromFacts({ kind: "device", device_key_id: "vyred", person: w.d.kernel.id.owner, path: "direct" }), {})).token;
  const asToken = (/** @type {string} */ token) => ({ root: w.root, caller: "cli", headers: { "x-vyre-kernel-session": token } });

  const me = await call("records.me", {}, asToken(team));
  assert.ok(!me.error, JSON.stringify(me.error));
  assert.equal(me.data.person, ANA, "the member who spoke");
  assert.equal(me.data.space, firm.space, "in the team's Space, though the model named none");

  // refused: a forged token, a body edited to name the team's Space under another key, the home's own token naming the team's Space in the input, and a team token naming another Space
  const forged = team.split(".")[0] + ".AAAAAAAA";
  assert.equal((await call("records.me", {}, asToken(forged))).error.code, "no_session");
  assert.equal((await call("records.me", {}, asToken(`${Buffer.from(JSON.stringify({ v: 1, space: firm.space, person: OWNER, agent: null, session: "x", thread: null, chat: null, exp: Date.now() + 1e6 })).toString("base64url")}.${team.split(".")[1]}`))).error.code, "no_session", "a body made up under another body's mac");
  const read = (/** @type {string} */ token, /** @type {any} */ input) => call("records.list", { type: "chat-record", ...input }, asToken(token));
  assert.ok(!(await read(team, {})).error, "the member reads in the team's Space (no Space named)");
  assert.notEqual(((await call("records.me", { space: firm.space }, asToken(home))).data || {}).person, ANA, "the home's token is never taken for the member");
  assert.ok((await read(team, { space: other.space })).error, "a team token does not read in another Space");

  // the "mcp" caller class on the Drive's read tools is global: a HOME session token naming the team's Space reads none of its files, and a team member's token reads only what that member may
  const owner2 = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner2", person: OWNER, path: "direct", session: "s" });
  await firm.gateway.drive.put(owner2, "Clients/Harlow/retainer.txt", new Uint8Array(Buffer.from("retainer terms")));
  const asModel = (/** @type {string} */ token) => ({ root: w.root, caller: "mcp", headers: { "x-vyre-kernel-session": token } });
  const viaHome = await call("files.drive.space.list", { space: firm.space }, asModel(home));
  assert.ok(viaHome.error || !JSON.stringify(viaHome.data || {}).includes("retainer.txt"), `a home session token reads nothing of the team's Drive: ${JSON.stringify(viaHome).slice(0, 200)}`);
  const viaTeam = await call("files.drive.space.list", {}, asModel(team));
  assert.ok(!viaTeam.error && JSON.stringify(viaTeam.data).includes("retainer.txt"), `the member's own session reads it, in the team Space: ${JSON.stringify(viaTeam).slice(0, 200)}`);
});
