// @ts-check
// The Switchboard takes "the person's own surface" from the call's kernel chain, never from the caller label: on a real kernel-on daemon a web, setup, unknown
// `device:` and `tailnet:` label gets only its own label as the keyboard holder, and the owner's verified session is the owner's own surface.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { FAKE } from "../sessions/testing/boot.js";
import { ownSurface } from "./lease.js";
import { surfaceFor } from "./index.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";

test("surfaceFor with a kernel chain: only the chain names the person's own surface; the label is ignored", () => {
  const hop = (/** @type {any} */ via, id = "per_owner") => ({ hops: [{ actor: { kind: "person", id }, via }] });
  assert.equal(surfaceFor({}, "web", "", hop({ device: "device:k1" }), "per_owner"), "phone", "the owner's verified device");
  assert.equal(surfaceFor({ surface: "capsule" }, "web", "", hop({ device: "device:k1" }), "per_owner"), "capsule");
  assert.equal(surfaceFor({ surface: "deck" }, "web", "", hop({ device: "device:k1" }, "per_other"), "per_owner"), "via:web", "another member's device is not the owner's");
  assert.equal(surfaceFor({ surface: "cli:9" }, "cli", "", hop({ surface: "cli" }), "per_owner"), "cli:9", "the person's own socket names which surface");
  for (const label of ["web", "setup", "device:aaaaaaaaaaaaaaaa", "tailnet:owner@example", "tailnet:other@x"]) {
    assert.equal(surfaceFor({ surface: "deck" }, label, "owner@example", null, "per_owner"), `via:${label}`, `${label} with no chain`);
    assert.equal(surfaceFor({}, label, "owner@example", { hops: [{ actor: { kind: "service", id: "x" }, via: {} }] }, "per_owner"), label, `${label} with a service chain`);
  }
});

test("on a kernel-on daemon the keyboard holder follows the chain: a web, setup, unknown device: and tailnet: label get only their own label", { timeout: 90_000 }, async t => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", network: { owner: "owner@example" }, transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const owner = d.kernel.id.owner;
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "hello", surface: "deck" }, "cli");
  assert.ok(r.data && r.data.id, JSON.stringify(r));
  const lease = async (/** @type {string} */ label, /** @type {any} */ meta) => (await d.registry.call("threads.lease", { thread: r.data.id, surface: "deck" }, label, meta)).data;
  for (const label of ["web", "setup", "device:aaaaaaaaaaaaaaaa", "tailnet:owner@example", "tailnet:other@x"]) {
    const got = await lease(label, undefined);
    if (got) assert.equal(ownSurface(got.holder), false, `${label} must not hold the keyboard as the person's own surface (got ${got.holder})`);
  }
  // the owner at a verified session: the person's own surface, whatever label carries it
  const token = (await d.kernel.surfaces.open(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" }), {})).token;
  const mine = await lease("cli", { token });
  assert.equal(mine && mine.holder, "deck", JSON.stringify(mine));
});
