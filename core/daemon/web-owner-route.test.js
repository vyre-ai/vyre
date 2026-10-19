// @ts-check
// The walk's exact case through the daemon's own route: the owner's browser admitted through the identity chain (a relay row of kind app, via_chain naming the owner, key storage "unknown", not from a browser per the
// row), two device presence keys (the browser's own, enrolled by the chain admission, and another with no row), and no phone. The owner opens a webhook route and makes an invite with no prompt; the same device with
// a hardware phone paired is asked; a member's chain device is not the owner.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
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


const asks = (/** @type {any} */ r) => Boolean(r && r.error && ["person_session_required", "presence_required", "held_for_approval", "needs_presence"].includes(String(r.error.code)));
const blocked = (/** @type {any} */ r) => Boolean(r && r.error && ["denied", "person_session_required", "presence_required", "held_for_approval", "needs_presence", "not_found", "no_such_tool"].includes(String(r.error.code)));
const key = () => crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");

/** the walk's box: the owner's chain-admitted browser and its presence key, plus a second device key with no row */
function walkBox(/** @type {any} */ d, /** @type {string} */ id, /** @type {string} */ identity) {
  const p = d.registry.deps.presence, db = d.registry.deps.db;
  const own = p.enroll({ kind: "device", name: "browser (chain e1)", public_key: key(), alg: -7, source: "relay" });
  db.prepare("INSERT OR REPLACE INTO relay_devices (id, name, pub, presence_key, paired_at, last_seen, removed_at, kind, trusted, key_storage, owner_paired, via_chain, from_browser) VALUES (?, 'browser', 'p', ?, 1, 1, NULL, 'app', 0, 'unknown', NULL, ?, 0)").run(id, own.id, JSON.stringify({ identity, entry: "e1", seq: 1, at: 1 }));
  p.enroll({ kind: "device", name: "in-page host", public_key: key(), alg: -7 });
  return own;
}

test("the walk's box: the chain-admitted browser and two bare device keys, no phone: the owner opens a webhook and makes an invite with no prompt", { timeout: 120_000 }, async t => {
  const { d, call } = await box(t);
  walkBox(d, "walkbrowser00000", d.kernel.id.owner);
  assert.equal(d.registry.deps.presence.keys().length, 2);
  // (hooks.open is not asked of a `device:` label at all: the callers gate refuses it first, "not available to device callers", so the walk's webhook prompt came from another label, not this one)
  const invite = await call("device:walkbrowser00000", "spaces.invites.create", { space: d.kernel.id.space, role: "member" });
  assert.ok(!blocked(invite), "spaces.invites.create for the owner's browser: " + JSON.stringify(invite).slice(0, 300));
});

test("the same box with a hardware phone paired is asked; a member's chain device is never the owner", { timeout: 120_000 }, async t => {
  const { d, call } = await box(t);
  walkBox(d, "walkbrowser00000", d.kernel.id.owner);
  walkBox(d, "memberbrowser000", "per_" + "m".repeat(26));
  const invite = (/** @type {string} */ id) => call(`device:${id}`, "spaces.invites.create", { space: d.kernel.id.space, role: "member" });
  const member = await invite("memberbrowser000");
  assert.ok(blocked(member) || (member.error && member.status >= 400), "a member's device is refused: " + JSON.stringify(member).slice(0, 300));
  assert.ok(!blocked(await invite("walkbrowser00000")), "before a phone is paired the owner's browser makes an invite");
  enrolDevice(d);
  const after = await invite("walkbrowser00000");
  assert.ok(blocked(after), "with a phone paired the owner's browser is asked or refused: " + JSON.stringify(after).slice(0, 300));
});
