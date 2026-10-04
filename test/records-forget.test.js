// @ts-check
// Forgetting a record, end to end on a real daemon (a temp home, restarted; a test box, never a Mac): a task about the record holds a test value in its text; after the record is forgotten and the
// kernel restarts, the value is in no task event, not in the task-text table, not behind any task, and the record, its events and its change history are gone.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tempHome, present } from "./helpers.js";
import { start } from "../core/daemon/index.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

/** every sqlite file under a folder */
const dbs = (/** @type {string} */ dir) => fs.readdirSync(dir, { withFileTypes: true, recursive: true }).filter(e => e.isFile() && /\.(db|sqlite)$/.test(e.name)).map(e => path.join(e.parentPath ?? e.path, e.name));

test("records.forget: the task text about the record is emptied before the store scrub, and after a restart the value is nowhere a person or a tool can read it", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "dev-presence-stand-in"), ""); // the development stand-in for Face ID: every use is logged
  const standIn = { "x-vyre-kernel-proof": Buffer.from(JSON.stringify({ method: "stand-in" })).toString("base64url") };
  let d = await start({ root, log: () => {}, kernel: true, presence: present });
  const me = (/** @type {any} */ x) => x.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-f", person: x.kernel.id.owner, path: "direct", session: "s" });
  const space = d.kernel.id.space, gw = d.kernel.gateway, VALUE = "Zephyrine-4471-needle";
  const assistant = { kind: "agent", id: "assistant", space };
  await gw.records.define(me(d), { add_types: [{ name: "client", label: "Client", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "note", kind: "text", label: "Note" }] }] });
  const rec = await gw.records.create(me(d), "client", { name: "Jane Harlow", note: VALUE });
  await gw.records.update(me(d), "client", rec.id, { note: `${VALUE} again` }, 1);
  const keep = await gw.records.create(me(d), "client", { name: "Bob Keep" });
  const about = await gw.ask.request(me(d), { title: `Call Jane about ${VALUE}`, doer: assistant, output: { kind: "decision" }, record: rec.urn, note: `her file says ${VALUE}` });
  const other = await gw.ask.request(me(d), { title: "Nothing sensitive here", doer: assistant, output: { kind: "decision" }, record: keep.urn });
  const out = await gw.migrate.forget(me(d), { type: "client", id: rec.id });
  assert.equal(out.tasks_cleared, 1, "the one task about the record");
  const check = async (/** @type {any} */ x, /** @type {string} */ when) => {
    assert.equal(await x.kernel.gateway.records.get(me(x), "client", rec.id), null, `${when}: the record is gone`);
    assert.equal(JSON.stringify(x.kernel.log.read()).includes(VALUE), false, `${when}: the value is in no event`);
    const titles = Object.fromEntries((await x.kernel.gateway.ask.list(me(x), {})).map((/** @type {any} */ k) => [k.id, JSON.stringify(k)]));
    assert.equal(JSON.stringify(titles).includes(VALUE), false, `${when}: the value is behind no task`);
    assert.match(titles[about.id], /removed|no longer available/, `${when}: the task keeps its structure with a plain title`);
    assert.match(titles[other.id], /Nothing sensitive here/, `${when}: another record's task is untouched`);
    for (const f of dbs(root)) {
      const db = new DatabaseSync(f, { readOnly: true });
      try { const has = db.prepare("SELECT name FROM sqlite_master WHERE name = 'kernel_task_texts'").get(); if (has) assert.equal(JSON.stringify(db.prepare("SELECT * FROM kernel_task_texts").all()).includes(VALUE), false, `${when}: not in kernel_task_texts`); } finally { db.close(); }
    }
  };
  await check(d, "before the restart");
  await d.stop();
  d = await start({ root, log: () => {}, kernel: true, presence: present });
  t.after(() => d.stop());
  await check(d, "after the restart");
  const { call } = await import("../core/daemon/client.js");
  const found = await call("recall.search", { query: VALUE }, { root, caller: "cli" });
  assert.equal(JSON.stringify(found).includes(VALUE.replace(/-needle$/, "")) && JSON.stringify(found.data || {}).includes("Jane"), false, "recall finds nothing about it");
  // the tool the person uses: the answer counts what it did and says what it did not search
  const second = await d.kernel.gateway.records.create(me(d), "client", { name: "Sam Second" });
  const said = /** @type {any} */ ((await call("records.forget", { urn: second.urn }, { root, caller: "cli", headers: standIn })).data);
  assert.equal(said.forgotten, second.urn, JSON.stringify(said));
  assert.equal(typeof said.sessions_mentioning, "number", "Recall answered, so the count is a number: " + said.message);
  assert.match(said.message, /Sessions that quoted this record are not searched\. Forget them in Memory\./);
  assert.match(said.message, /no sealed values/);
  assert.equal(await d.kernel.gateway.records.get(me(d), "client", second.id), null);
  // an assistant only proposes: nothing is forgotten, a task is made
  const third = await d.kernel.gateway.records.create(me(d), "client", { name: "Tess Third" });
  const asked = /** @type {any} */ (await call("records.forget", { urn: third.urn }, { root, caller: "cli:agent:kit" }));
  assert.ok(asked.error, "an assistant cannot forget");
  assert.ok(await d.kernel.gateway.records.get(me(d), "client", third.id), "the record is still there");
});
