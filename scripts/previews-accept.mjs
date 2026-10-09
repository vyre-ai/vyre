#!/usr/bin/env node
// previews-accept: a Claude-style artifact page (core/previews/testing/artifact-dashboard.html: stored data, who is looking, a model call, a download) runs UNCHANGED in a Vyre preview, in a real browser, against a
// real daemon: the viewer allows each capability, tasks are added and live-update, they survive a reload, a download is offered. Needs playwright (PW_FROM=<folder with playwright installed>/).
//   PW_FROM=~/shots/ node scripts/previews-accept.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { tempHome, present, asOwner } from "../test/helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const require = createRequire(process.env.PW_FROM || path.join(os.homedir(), "shots/"));
const { chromium } = require("playwright");
const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ? path.resolve(process.argv[2]) : "";
if (out) fs.mkdirSync(out, { recursive: true });

const stub = { after() {} };
const root = tempHome(stub);
fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box" }));
const d = await start({ root, presence: present, log: () => {}, kernel: true });
asOwner(d, root);
const call = (tool, input, caller = "cli") => d.registry.call(tool, input, caller);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-accept-"));
fs.copyFileSync(path.join(here, "../core/previews/testing/artifact-dashboard.html"), path.join(dir, "index.html"));
let browser;
try {
  const frontPort = (await call("appmods.front", {}, "module:previews")).data.port;
  const pv = await call("previews.open", { title: "Case tasks", path: dir, capabilities: { db: {}, user: {}, sample: {}, downloads: true } });
  assert.ok(pv.data, JSON.stringify(pv));
  // on localhost the front has a port, so the address names it (the ticket is made for that exact host)
  const ticket = new URL((await call("previews.url", { id: pv.data.id, origin: `http://localhost:${frontPort}` })).data.url);
  const url = ticket.href;
  browser = await chromium.launch();
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 800 }, colorScheme: scheme, acceptDownloads: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (process.env.ACCEPT_DEBUG) console.log("console:", m.type(), m.text()); });
    page.on("response", (r) => { if (process.env.ACCEPT_DEBUG) console.log("http:", r.status(), r.url().replace(/\?t=.*/, "")); });
    await page.goto(scheme === "light" ? url : `${ticket.origin}/`, { waitUntil: "networkidle" });
    if (scheme === "dark") { /* a second context has no session: the preview is closed to it */ assert.equal(await page.locator("body").innerText(), "not found"); await ctx.close(); continue; }
    // the viewer is asked, in the page's own words, before stored data starts
    const allow = page.getByRole("button", { name: "Allow" });
    await allow.waitFor({ timeout: 15000 });
    assert.match(await page.locator("[role=dialog]").innerText(), /store and share its own data/);
    if (out) await page.screenshot({ path: path.join(out, `consent-${scheme}.png`) });
    await allow.click();
    // add tasks: they appear live
    await page.getByLabel("New task").fill("Call the client");
    await page.getByRole("button", { name: "Add" }).click();
    await page.getByLabel("New task").fill("File the motion");
    await page.getByRole("button", { name: "Add" }).click();
    await page.getByText("File the motion").waitFor();
    assert.equal(await page.locator("li").count(), 2);
    // the user capability asks too, on first use, in its own words; the page greets by name
    const userAllow = page.getByRole("button", { name: "Allow" });
    if (await userAllow.count()) { assert.match(await page.locator("[role=dialog]").innerText(), /know who you are/); await userAllow.click(); await page.getByText(/Signed in as/).waitFor(); }
    await page.getByLabel("Done: Call the client").check();
    await page.locator("li.done").waitFor();
    if (out) await page.screenshot({ path: path.join(out, `tasks-${scheme}.png`), fullPage: true });
    // a reload: the data is still there (kept in Vyre's records, not in the page)
    await page.reload({ waitUntil: "networkidle" });
    await page.getByText("File the motion").waitFor({ timeout: 15000 });
    assert.equal(await page.locator("li").count(), 2);
    assert.equal(await page.locator("li.done").count(), 1);
    // a download is offered and the viewer confirms it
    const dl = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV" }).click();
    const dlAllow = page.getByRole("button", { name: "Allow" });
    if (await dlAllow.count()) await dlAllow.click();
    await page.getByRole("button", { name: "Save" }).click();
    const file = await dl;
    assert.equal(file.suggestedFilename(), "tasks.csv");
    assert.match(fs.readFileSync(await file.path(), "utf8"), /"Call the client",true\n"File the motion",false/);
    // the model: this daemon has no model, so the page's own error path runs, unchanged
    await page.getByRole("button", { name: "Summarize" }).click();
    const sampleAllow = page.getByRole("button", { name: "Allow" });
    if (await sampleAllow.count()) await sampleAllow.click();
    await page.locator("#summary").waitFor();
    assert.deepEqual(errors, [], "the page had no errors of its own");
    await ctx.close();
  }
  console.log("ok: a Claude-style artifact page ran unchanged in a Vyre preview");
} catch (e) {
  console.error("FAILED:", e && e.message ? e.message : e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await d.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}
