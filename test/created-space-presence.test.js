// @ts-check
// A Space made by spaces.create has its own kernel: the development presence stand-in (a hand-made file in a development build) must reach it as it reaches the home's, or the walk's
// admin acts there answer needs_presence. Without the file the hosted kernel still asks for presence. A test box, never a Mac.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempHome } from "./helpers.js";
import { start } from "../core/daemon/index.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const TYPE = { name: "note", label: "Note", fields: [{ name: "title", kind: "text", label: "Title" }] };

/** @param {boolean} standIn */
async function defineInCreated(t, standIn) {
  const root = tempHome(t);
  if (standIn) fs.writeFileSync(path.join(root, "dev-presence-stand-in"), "walk\n");
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const h = await d.kernel.spaces.host({ owner: d.kernel.id.owner, name: "created" });
  const chain = h.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-walk", person: d.kernel.id.owner, path: "direct" });
  return h.gateway.records.define(chain, { add_types: [TYPE] }).then(() => "applied", (/** @type {any} */ e) => e.code);
}

test("a created Space accepts its owner's admin act under the development stand-in, and asks for presence without it", { timeout: 120_000 }, async t => {
  assert.equal(await defineInCreated(t, false), "needs_presence", "no stand-in file: presence is asked for");
  assert.equal(await defineInCreated(t, true), "applied", "the stand-in file reaches the created Space's own kernel");
});

test("a real person session reaches a created Space through chainIn with no stand-in: the owner's device that signed in defines a type there, and the same device with no session is asked for presence", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const owner = d.kernel.id.owner;
  const handle = d.kernel.kernelFor({ name: "spaces", needs: { kernel: { actions: [], spaces: true } } });
  const h = await d.kernel.spaces.host({ owner, name: "created" });
  // the box knows this phone as the owner's paired device (an active relay_devices row): enrolment is for devices the box actually paired, never an invented id
  d.registry.deps.db.prepare("INSERT INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, ?, 'p', 1, 'app', 0, NULL)").run("dphonepaired00001", "phone");
  const as = (/** @type {any} */ extra) => handle.chainIn(h.space, { kernelFacts: { kind: "device", device_key_id: "dphonepaired00001", person: owner, path: "relay", ...extra } });
  const signedIn = await as({ session: "ps_1" });
  await h.gateway.records.define(signedIn, { add_types: [TYPE] });
  assert.ok((await h.gateway.records.create(signedIn, "note", { title: "from the phone" })).urn, "the signed-in owner device works in the created Space");
  const noSession = await as({});
  await assert.rejects(() => h.gateway.records.define(noSession, { add_types: [{ ...TYPE, name: "other" }] }), { code: "needs_presence" });
});
