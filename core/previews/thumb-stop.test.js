// @ts-check
// A preview opened a moment before the daemon stops: its thumbnail timer is cleared by stop(), so nothing fires on a closed database (J4 failed in CI on a late "database is not open" that nobody caught).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present, asOwner } from "../../test/helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_PREVIEW_THUMBS = "1";

test("a preview opened just before stop leaves no thumbnail timer that fires after the database is closed", { timeout: 60_000 }, async t => {
  /** @type {unknown[]} */ const late = [];
  const on = (/** @type {unknown} */ e) => { late.push(e); };
  process.on("unhandledRejection", on);
  t.after(() => process.off("unhandledRejection", on));
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box" }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  const site = fs.mkdtempSync(path.join(root, "pv-site-"));
  fs.writeFileSync(path.join(site, "index.html"), "<h1>Northwind</h1>");
  const opened = await d.registry.call("previews.open", { title: "Northwind", path: site }, "cli");
  assert.ok(!opened.error, JSON.stringify(opened.error));
  await d.stop();
  await new Promise(r => setTimeout(r, 2500)); // longer than the thumbnail timer (1.5 s)
  assert.deepEqual(late.map(e => String(/** @type {any} */ (e)?.message ?? e)), [], "nothing rejected after the stop");
});
