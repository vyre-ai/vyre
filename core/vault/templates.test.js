// App templates for the Vault's Add sheet (tools/templates.js): the model is sent the app's name and nothing else, no AI account falls back to no fields (the screen offers a blank
// item), and a kept template is offered the next time without asking again.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { SYSTEM, appKey, appName, cleanFields, makeTemplates } from "./tools/templates.js";
import { connectOwn } from "../../lib/own-account.js";

const folder = (/** @type {any} */ t) => { const d = fs.mkdtempSync(path.join(SCRATCH, "vyre-templates-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const ANSWER = JSON.stringify({ fields: [
  { name: "northwind api-key", secret: true, help: "Settings, Developer, Private keys." },
  { name: "Northwind_Location_Id", secret: false, help: "Settings, Business profile." },
  { name: "NORTHWIND_API_KEY", secret: true, help: "a second spelling of the first: kept once" },
] });

test("the suggestion sends the app's name and nothing else, and keeps what comes back as names in one form", async (t) => {
  /** @type {{ tool: string, input: any }[]} */ const seen = [];
  const tp = makeTemplates({ dir: folder(t), call: async (tool, input) => { seen.push({ tool, input }); return { data: { ok: true, text: `Here: ${ANSWER}` } }; } });
  const r = await tp.suggest("  Northwind   Bakery ");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tool, "threads.quick");
  assert.deepEqual(Object.keys(seen[0].input).sort(), ["prompt", "purpose", "spend_purpose", "system", "timeout_ms"], "no other material rides along");
  assert.equal(seen[0].input.prompt, "App: Northwind Bakery", "the app's name is the whole prompt");
  assert.equal(seen[0].input.system, SYSTEM, "the system words are fixed, the same for every app");
  assert.equal(r.source, "ai");
  assert.deepEqual(r.fields.map((f) => [f.name, f.secret]), [["NORTHWIND_API_KEY", true], ["NORTHWIND_LOCATION_ID", false]], "canonical, once each, plain or secret as suggested");
});

test("a name that looks like a key is refused before any model is asked", async (t) => {
  let asked = 0;
  const tp = makeTemplates({ dir: folder(t), call: async () => { asked++; return { data: { ok: true, text: ANSWER } }; } });
  await assert.rejects(() => tp.suggest("sk-" + "ant-" + "api03-" + "a".repeat(40)), /looks like a key/);
  await assert.rejects(() => tp.suggest(""), /app's name/);
  assert.equal(asked, 0);
  assert.equal(appName(" Juniper   Drive "), "Juniper Drive");
});

test("no AI account of the person's own: no fields and the reason, so the screen offers a blank item; nothing is kept", async (t) => {
  const dir = folder(t);
  const none = makeTemplates({ dir, call: async () => ({ error: { code: "no_account", message: connectOwn("this") } }) });
  assert.deepEqual(await none.suggest("Northwind Bakery"), { app: "Northwind Bakery", fields: [], source: "none", why: "no_account" });
  const thrown = makeTemplates({ dir, call: async () => { throw Object.assign(new Error(connectOwn(null)), { code: "denied" }); } });
  assert.equal((await thrown.suggest("Northwind Bakery")).why, "no_account");
  const silent = makeTemplates({ dir, call: async () => ({ data: { ok: true, text: "I do not know that app." } }) });
  assert.deepEqual(await silent.suggest("Northwind Bakery"), { app: "Northwind Bakery", fields: [], source: "none", why: "no_answer" });
  assert.deepEqual(none.list(), [], "a failed suggestion keeps nothing");
});

test("a kept template is offered the next time, by any spelling of the app, without asking the model again", async (t) => {
  const dir = folder(t);
  let asked = 0;
  const call = async () => { asked++; return { data: { ok: true, text: ANSWER } }; };
  await makeTemplates({ dir, call, now: () => 1 }).suggest("Northwind Bakery");
  const next = makeTemplates({ dir, call });
  const again = await next.suggest("northwind-bakery");
  assert.equal(asked, 1, "the second person's ask is answered from the Space's template");
  assert.equal(again.source, "space");
  assert.deepEqual(again.fields.map((f) => f.name), ["NORTHWIND_API_KEY", "NORTHWIND_LOCATION_ID"]);
  assert.deepEqual(next.list().map((x) => x.app), ["Northwind Bakery"]);
  assert.equal(appKey("Northwind-Bakery"), appKey("northwind bakery"));
  assert.ok(!fs.readFileSync(path.join(dir, "templates.json"), "utf8").includes("value"), "the file holds names and help lines only");
});

test("fields from a model are cleaned: names in one form, short printable help, at most sixteen", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `key ${i}`, help: "x\u0007y" }));
  const out = cleanFields(many);
  assert.equal(out.length, 16);
  assert.equal(out[0].name, "KEY_0");
  assert.equal(out[0].help, "x y");
  assert.equal(out[0].secret, true, "a field is secret unless it says it is not");
  assert.deepEqual(cleanFields("nope"), []);
});
