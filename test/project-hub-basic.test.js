// @ts-check
// A Basic personal space has no server and no Drive: the project hub writes through the real kernel's records handle (the device's own store) and the project's folder is a plain device folder.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createKernel } from "../kernel/index.js";
import { createHub } from "../core/work/hub.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
const needs = JSON.parse(fs.readFileSync(new URL("../core/work/module.json", import.meta.url), "utf8")).needs;

test("on a kernel with no Drive the hub makes a project record in the device's store, with this computer's folder as its home, and files a session under it", async () => {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 5) });
  assert.equal(k.gateway.drive, undefined, "a device kernel here has no Drive");
  const h = k.kernelFor({ name: "work", needs });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  await h.records.define(h.serviceChain("work"), { add_types: needs.kernel.types }).catch(() => null);
  /** @type {string[]} */ const adopted = [];
  const hub = createHub({ kernel: h, call: async (tool, input) => { if (tool === "projects.adopt") { adopted.push(input.slug); return { data: { slug: input.slug, name: input.name, home: `/home/alex/Work/${input.slug}` } }; } return null; } });
  const proj = await hub.createProject(owner, { name: "Rivera" });
  assert.equal(proj.data.drive_path, "/home/alex/Work/rivera", "a plain device folder");
  assert.deepEqual(adopted, ["rivera"]);
  const back = await k.gateway.records.get(owner, "project", proj.id);
  assert.equal(back.data.name, "Rivera");
  assert.equal(back.data.drive_path, "/home/alex/Work/rivera", "stored in the device's own store");
});
