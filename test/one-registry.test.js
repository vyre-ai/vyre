// @ts-check
// ONE space id, the kernel's: spaces.create hosts the Space in the kernel's Spaces registry FIRST (spc_ plus 12 base32), stores its name, address and members against that id, and the
// kernel's own tools then work in it: records.define and records.create, tasks.list. A real vyred with the kernel on, the stand-in names directory, no module-local id anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome, present } from "./helpers.js";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "standin-directory.mjs");
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => res(p)); }); });
const CONTACT = { name: "contact", label: "Contact", fields: [{ name: "name", kind: "text", label: "Name", required: true }] };

test("spaces.create makes the kernel's Space first and its id is the one id; records and tasks work in it", async t => {
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "one-registry-box", transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const lines = /** @type {string[]} */ ([]);
  const d = await start({ root, kernel: true, presence: present, log: m => lines.push(String(m)) });
  t.after(() => d.stop());
  const deck = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller: "deck" });
  const made = await deck("spaces.identity.create", { name: "alex" });
  assert.ok(!made.error, JSON.stringify(made.error));
  const sp = await deck("spaces.create", { name: "harlow", displayName: "Harlow Legal", home: { kind: "this-computer", confirmed: true } });
  assert.ok(!sp.error, JSON.stringify(sp.error));
  assert.equal(sp.data.status, "done", JSON.stringify(sp.data) + lines.filter(l => /records|spaces/.test(l)).join(" ; "));
  const id = sp.data.space;
  assert.match(id, /^spc_[a-z2-7]{12}$/, "the kernel's id, not a module-local one");
  assert.equal(sp.data.warnings.length, 0, JSON.stringify(sp.data.warnings));
  const got = await deck("spaces.get", { space: "harlow" });
  assert.ok(!got.error, JSON.stringify(got.error));
  assert.deepEqual([got.data.id, got.data.name, got.data.role, got.data.members], [id, "harlow.vyre.run", "owner", 1]);
  // the kernel's own tools work in it, under the person's chain
  // a type the Space already has (the kernel's core types come with it): no admin act needed
  const types = await deck("records.types", { space: id });
  assert.ok(!types.error, JSON.stringify(types.error));
  const tname = (types.data.types.types || types.data.types).map((/** @type {any} */ t) => t.name).find((/** @type {string} */ n) => n === "contact" || n === "person" || n === "client") || (types.data.types.types || types.data.types)[0].name;
  const tdef = (types.data.types.types || types.data.types).find((/** @type {any} */ t) => t.name === tname);
  const data = Object.fromEntries((tdef.fields || []).filter((/** @type {any} */ f) => f.required).map((/** @type {any} */ f) => [f.name, f.kind === "text" ? "Jane" : "Jane"]));
  const rec = await deck("records.create", { space: id, type: tname, data: Object.keys(data).length ? data : { name: "Jane" } });
  assert.ok(!rec.error, tname + " " + JSON.stringify(rec.error) + JSON.stringify(tdef).slice(0, 300));
  const list = await deck("records.list", { space: id, type: tname });
  assert.ok(!list.error && JSON.stringify(list.data).includes("Jane"), JSON.stringify(list));
  const tasks = await deck("tasks.list", { space: id });
  assert.ok(!tasks.error, JSON.stringify(tasks.error));
  const me = await deck("records.me", { space: id });
  assert.equal(me.data.space, id);
});
