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
    // the viewer is asked, in plain words, before anything starts: each capability the page uses asks at its first use, and Allow lets it through
    const asked = [];
    const answer = async (name = "Allow", ms = 8000) => {
      const dlg = page.locator("[role=dialog]");
      try { await dlg.waitFor({ timeout: ms }); } catch { return false; }
      asked.push(await dlg.innerText());
      if (out && asked.length === 1) await page.screenshot({ path: path.join(out, `consent-${scheme}.png`) });
      await page.getByRole("button", { name }).click();
      return true;
    };
    while (await answer("Allow", asked.length >= 2 ? 1500 : 15000)) { /* until the page has what it needs */ }
    assert.ok(asked.some((t) => /store and share its own data/.test(t)), `stored data was asked for: ${JSON.stringify(asked)}`);
    assert.ok(asked.some((t) => /know who you are/.test(t)), "who is looking was asked for");
    await page.getByText(/Signed in as/).waitFor();
    // add tasks: they appear live
    await page.getByLabel("New task").fill("Call the client");
    await page.getByRole("button", { name: "Add" }).click();
    await page.getByLabel("New task").fill("File the motion");
    await page.getByRole("button", { name: "Add" }).click();
    await page.getByText("File the motion").waitFor();
    assert.equal(await page.locator("li").count(), 2);
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
    assert.ok(await answer("Allow", 4000), "downloads asked");
    assert.ok(await answer("Save", 4000), "and the viewer confirmed the file");
    const file = await dl;
    assert.equal(file.suggestedFilename(), "tasks.csv");
    assert.match(fs.readFileSync(await file.path(), "utf8"), /"Call the client",true\n"File the motion",false/);
    // the model: this daemon has no model, so the page's own error path runs, unchanged
    await page.getByRole("button", { name: "Summarize" }).click();
    assert.ok(await answer("Allow", 4000), "the model asked");
    await page.locator("#summary").waitFor();
    assert.match(await page.locator("#summary").innerText(), /could not answer: (unavailable|not_granted)/);
    assert.deepEqual(errors, [], "the page had no errors of its own");
    await ctx.close();
  }
  // the same page inside Vyre's own app: a frame on another origin, signed in by an embed ticket (a cookie that works in a frame), the page's own markup untouched
  {
    const { default: http } = await import("node:http");
    const host = http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(`<!doctype html><title>the app</title><iframe id="f" title="preview" style="width:420px;height:700px;border:0" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" src="${embedUrl}"></iframe>`); });
    await new Promise((r) => host.listen(0, "127.0.0.1", r));
    const embedUrl = new URL((await call("previews.url", { id: pv.data.id, origin: `http://localhost:${frontPort}`, embed: true })).data.url).href;
    host.removeAllListeners("request");
    host.on("request", (q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(`<!doctype html><title>the app</title><iframe id="f" title="preview" style="width:420px;height:700px;border:0" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" src="${embedUrl}"></iframe>`); });
    const ctx = await browser.newContext({ viewport: { width: 460, height: 760 } });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${host.address().port}/`, { waitUntil: "networkidle" });
    const frame = page.frameLocator("#f");
    await frame.getByRole("heading", { name: "Case tasks" }).waitFor({ timeout: 15000 });
    assert.ok(await frame.getByText("File the motion").count() >= 0);
    await ctx.close();
    host.close();
  }
  console.log("ok: a Claude-style artifact page ran unchanged in a Vyre preview, and in a frame of another origin");
} catch (e) {
  console.error("FAILED:", e && e.message ? e.message : e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await d.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}
