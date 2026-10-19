// @ts-check
// The owner's ruling (19 Oct) through the daemon's own route: with no presence key enrolled, the owner's relay-paired browser (a "web" device) and app (an "app" device), named as the owner's by Wink's record,
// make an invite and open a webhook route without a sign-in prompt. A member's device, a removed one, an agent label and every call once a key is enrolled are asked as before, and ownership steps still ask.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { start } from "./index.js";
import { tempHome, pairDevice, enrolDevice } from "../../test/helpers.js";

const MEMBER = "per_" + "m".repeat(26);

/** @param {import("node:test").TestContext} t */
async function box(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "alex", vault: { keystore: "file" } }));
  const d = await start({ root, kernel: true, log: () => {} });
  t.after(() => d.stop());
  const ctx = d.registry.context({ name: "names", version: "0.1.0", does: { tools: [] }, watches: { emits: ["owner.seen"] } });
  /** @param {string} label @param {string} tool @param {any} input */
  const call = async (label, tool, input) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]), { method: "POST", url: `/v1/tools/${tool}`, headers: { host: "relay", "content-type": "application/json", "sec-fetch-site": "same-origin", "sec-fetch-dest": "empty" } });
    let out = "", status = 0;
    const res = { setHeader() {}, writeHead(/** @type {number} */ s) { status = s; }, end(b = "") { out += b; }, headersSent: false };
    await ctx.handler({})(req, res, label, { kind: "device", stableId: "dev1", node: "dev1", login: null, tags: [], caps: {} });
    return { status, ...(out ? JSON.parse(out) : {}) };
  };
  /** @param {string} id @param {"app"|"web"} kind @param {string} identity @param {boolean} [removed] */
  const pair = (id, kind, identity, removed = false) => {
    pairDevice(d, id, identity);
    d.registry.deps.db.prepare("UPDATE relay_devices SET kind = ?, removed_at = ? WHERE id = ?").run(kind, removed ? 5 : null, id);
  };
  return { d, call, pair };
}

const asks = (/** @type {any} */ r) => Boolean(r && r.error && ["person_session_required", "presence_required", "denied", "held_for_approval"].includes(String(r.error.code)));
const SPACE = (/** @type {any} */ d) => d.kernel.id.space;

test("with no presence key, the owner's web and app devices pass; a member's, a removed one and an agent are asked or refused", { timeout: 120_000 }, async t => {
  const { d, call, pair } = await box(t);
  const owner = d.kernel.id.owner;
  assert.equal(d.registry.deps.presence.keys().length, 0, "nothing enrolled");
  pair("webowner0000000a", "web", owner);
  pair("appowner0000000a", "app", owner);
  pair("memberdev0000000", "app", MEMBER);
  pair("removeddev000000", "web", owner, true);
  const invite = (/** @type {string} */ id) => call(`device:${id}`, "spaces.invites.create", { space: SPACE(d), role: "member" });
  const outs = {};
  for (const id of ["webowner0000000a", "appowner0000000a"]) outs[id] = await invite(id);
  assert.deepEqual(Object.entries(outs).filter(([, r]) => asks(r)).map(([id, r]) => `${id}: ${JSON.stringify(r).slice(0, 200)}`), [], "the owner's devices make an invite with no prompt");
  for (const id of ["memberdev0000000", "removeddev000000"]) {
    const r = await invite(id);
    assert.ok(asks(r) || (r.error && r.status >= 400), `${id}: refused: ${JSON.stringify(r).slice(0, 240)}`);
    assert.ok(!(r.data && r.data.token), `${id}: no invitation made`);
  }
  const agent = await call("mcp:agent:kit", "spaces.invites.create", { space: SPACE(d), role: "member" });
  assert.ok(agent.error && !(agent.data && agent.data.token), "an agent label makes no invite: " + JSON.stringify(agent).slice(0, 200));
  // ownership steps keep their presence step, for the owner's own browser too
  const hand = await call("device:webowner0000000a", "spaces.owner.transfer", { space: SPACE(d), to: MEMBER });
  assert.ok(asks(hand), "ownership transfer still asks: " + JSON.stringify(hand).slice(0, 200));
});

test("once any presence key is enrolled, the owner's web and app devices are asked again on the very next call", { timeout: 120_000 }, async t => {
  const { d, call, pair } = await box(t);
  const owner = d.kernel.id.owner;
  pair("webowner0000000a", "web", owner);
  pair("appowner0000000a", "app", owner);
  const invite = (/** @type {string} */ id) => call(`device:${id}`, "spaces.invites.create", { space: SPACE(d), role: "member" });
  assert.ok(!asks(await invite("webowner0000000a")), "before: no prompt");
  enrolDevice(d);
  for (const id of ["webowner0000000a", "appowner0000000a"]) {
    const r = await invite(id);
    assert.ok(asks(r), `${id}: after a phone is enrolled the prompt is back: ${JSON.stringify(r).slice(0, 240)}`);
  }
});
