// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { start } from "../daemon/index.js";
import { build } from "../daemon/build.js";
import { tempHome } from "../../test/helpers.js";

/** A GitHub Releases API on a free port. `list` is read on every request, so a test can change it. */
async function releasesApi(t, list) {
  const hits = { n: 0 };
  const server = http.createServer((req, res) => {
    hits.n++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(list.value));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`, hits };
}
const rel = (tag, body = "", pre = false) => ({ tag_name: tag, draft: false, prerelease: pre, body, published_at: "2026-09-30T00:00:00Z", assets: [] });
const bump = (v, part) => { const [a, b, c] = v.replace(/-.*/, "").split(".").map(Number); return part === "major" ? `${a + 1}.0.0` : part === "minor" ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`; };

async function box(t, api, config = {}) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], network: { onboardPort: 0 }, ...config }));
  const saved = process.env.VYRE_RELEASES_API;
  process.env.VYRE_RELEASES_API = api;
  const d = await start({ root, log: () => {} });
  t.after(async () => { await d.stop(); if (saved === undefined) delete process.env.VYRE_RELEASES_API; else process.env.VYRE_RELEASES_API = saved; });
  const events = [];
  d.events?.on?.("update.available", e => events.push(e));
  return { root, d, events, call: (tool, input = {}) => d.registry.call(tool, input, "cli") };
}

test("update: status says up to date before any look, and names the one command a box runs", async t => {
  const api = await releasesApi(t, { value: [] });
  const b = await box(t, api.url);
  const r = (await b.call("update.status")).data;
  assert.equal(r.current, build().version);
  assert.equal(r.available, null);
  assert.equal(r.checkedAt, null);
  assert.equal(r.how, "command");
  assert.equal(r.command, "vyre update");
  assert.equal(api.hits.n, 0, "status never asks the network");
});

test("update: a newer release is reported with the notes since this version, once as an event, and a look inside a minute is not repeated", async t => {
  const cur = build().version, next = bump(cur, "minor"), newest = bump(next, "patch");
  const list = { value: [rel(`v${newest}`, "Fixes the tailnet check."), rel(`v${next}`, "New Settings card."), rel(`v${cur}`, "The one you run."), rel(`v${bump(newest, "minor")}-beta.1`, "not for stable", true)] };
  const api = await releasesApi(t, list);
  const b = await box(t, api.url);
  const r = (await b.call("update.check")).data;
  assert.equal(r.available, newest, "the newest stable, not the beta");
  assert.deepEqual(r.notes.map(n => n.version), [newest, next]);
  assert.equal(r.notes[1].notes, "New Settings card.");
  assert.ok(r.checkedAt > 0);
  assert.equal(api.hits.n, 1);
  await b.call("update.check");
  assert.equal(api.hits.n, 1, "asked again inside a minute: answered from the last look");
  // The saved answer survives a restart, and status does not ask.
  const again = (await b.call("update.status")).data;
  assert.equal(again.available, newest);
  assert.equal(JSON.parse(fs.readFileSync(path.join(b.root, "update.json"), "utf8")).announced, newest, "announced once, and remembered");
});

test("update: an unreachable releases API is an error to show, not a crash, and status still answers", async t => {
  const b = await box(t, "http://127.0.0.1:9");
  const r = (await b.call("update.check")).data;
  assert.equal(r.available, null);
  assert.ok(r.error, "the reason is kept");
  assert.equal((await b.call("update.status")).data.current, build().version);
});

test("update: auto off never looks", async t => {
  const api = await releasesApi(t, { value: [rel(`v${bump(build().version, "major")}`)] });
  const b = await box(t, api.url, { update: { auto: "off" } });
  const r = (await b.call("update.check")).data;
  assert.equal(r.auto, "off");
  assert.equal(r.available, null);
  assert.equal(api.hits.n, 0);
});
