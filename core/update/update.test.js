// @ts-check
import "../../scripts/mac-test-guard.mjs";
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
  // The two folders the compose file mounts: what vyred drops a request into, and what the host writes back.
  const req = path.join(root, "update-req"), state = path.join(root, "update-state");
  fs.mkdirSync(req); fs.mkdirSync(state);
  const savedEnv = { a: process.env.VYRE_UPDATE_DIR, b: process.env.VYRE_UPDATE_STATE, c: process.env.VYRE_UPDATE_QUIET };
  process.env.VYRE_UPDATE_DIR = req; process.env.VYRE_UPDATE_STATE = state; process.env.VYRE_UPDATE_QUIET = "0-24";
  t.after(() => { for (const [k, v] of [["VYRE_UPDATE_DIR", savedEnv.a], ["VYRE_UPDATE_STATE", savedEnv.b], ["VYRE_UPDATE_QUIET", savedEnv.c]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  // The channel is stated, not read from the build: a box running a prerelease (0.2.0-rc.1) follows beta by design, and these tests are about
  // stable (a test may pass its own update settings; the channel stays stable unless it says otherwise).
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], network: { onboardPort: 0 }, ...config, update: { channel: "stable", ...(config.update || {}) } }));
  const saved = process.env.VYRE_RELEASES_API;
  process.env.VYRE_RELEASES_API = api;
  const d = await start({ root, log: () => {} });
  t.after(async () => { await d.stop(); if (saved === undefined) delete process.env.VYRE_RELEASES_API; else process.env.VYRE_RELEASES_API = saved; });
  const events = [];
  d.events?.on?.("update.available", e => events.push(e));
  return { root, d, events, req, state, call: (tool, input = {}) => d.registry.call(tool, input, "cli") };
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

const ready = b => fs.writeFileSync(path.join(b.state, "ready"), "1\n");

test("update.apply: with no host unit it says so and drops nothing; with one it drops the one word, and only the person may ask", async t => {
  const api = await releasesApi(t, { value: [] });
  const b = await box(t, api.url);
  assert.equal((await b.call("update.status")).data.canApply, false);
  const no = await b.call("update.apply");
  assert.equal(no.error.code, "unavailable");
  assert.match(no.error.message, /run vyre update/);
  ready(b);
  const st = (await b.call("update.status")).data;
  assert.equal(st.canApply, true);
  const yes = await b.call("update.apply");
  assert.equal(yes.data.requested, true, JSON.stringify(yes));
  assert.equal(fs.readFileSync(path.join(b.req, "request"), "utf8"), "update\n", "one word, no arguments");
  assert.deepEqual(fs.readdirSync(b.req), ["request"], "no temp file left behind");
  assert.equal((await b.call("update.status")).data.pending, true);
  const again = await b.call("update.apply");
  assert.equal(again.data.requested, false, "a second ask while one is pending does nothing");
  for (const who of ["agent:x", "mcp", "module:other"]) assert.equal((await b.d.registry.call("update.apply", {}, who)).error?.code, "denied", who);
});

test("update.status: what the host wrote comes back as known words only, and a stale running is a failure", async t => {
  const api = await releasesApi(t, { value: [] });
  const b = await box(t, api.url);
  ready(b);
  const write = o => fs.writeFileSync(path.join(b.state, "status.json"), JSON.stringify(o));
  write({ state: "running", stage: "backing-up", message: "", from: "0.1.0", to: "0.2.0", at: Math.floor(Date.now() / 1000) });
  let r = (await b.call("update.status")).data.run;
  assert.deepEqual([r.state, r.stage, r.from, r.to], ["running", "backing-up", "0.1.0", "0.2.0"]);
  assert.equal((await b.call("update.apply")).data.requested, false, "running: not again");
  write({ state: "rolled_back", stage: "restarting", message: "rolled back to the release before", from: "0.1.0", to: "0.2.0", at: Math.floor(Date.now() / 1000) });
  r = (await b.call("update.status")).data.run;
  assert.equal(r.state, "rolled_back");
  write({ state: "running", stage: "<script>", message: "x\u0000y".repeat(400), from: "0.1.0", to: "0.2.0", at: Math.floor(Date.now() / 1000) - 4 * 3600 });
  r = (await b.call("update.status")).data.run;
  assert.equal(r.state, "failed");
  assert.equal(r.stage, "none", "a stage that is not a known word is dropped");
  write({ state: "exploded" });
  assert.equal((await b.call("update.status")).data.run, null);
  fs.writeFileSync(path.join(b.state, "status.json"), "{ not json");
  assert.equal((await b.call("update.status")).data.run, null);
});

test("update automatically: off by default; when on, a new signed-release ask is made once per version in the quiet hours, and never with a run going", async t => {
  const cur = build().version, next = bump(cur, "minor");
  const list = { value: [rel(`v${next}`, "New.")] };
  const api = await releasesApi(t, list);
  // Off (the default): the look finds the release and nothing is asked.
  const off = await box(t, api.url);
  ready(off);
  await off.call("update.check");
  assert.equal((await off.call("update.status")).data.available, next);
  assert.equal(fs.existsSync(path.join(off.req, "request")), false, "off by default: nothing asked");
  assert.equal((await off.call("update.status")).data.install, false);
  // On: the look asks, once.
  const on = await box(t, api.url, { update: { install: true } });
  ready(on);
  await on.call("update.check");
  assert.equal(fs.readFileSync(path.join(on.req, "request"), "utf8"), "update\n");
  fs.rmSync(path.join(on.req, "request"));
  fs.writeFileSync(path.join(on.root, "update.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(on.root, "update.json"), "utf8")) }));
  await on.call("update.check");
  assert.equal(fs.existsSync(path.join(on.req, "request")), false, "one ask per version, even if it failed");
  // Outside the quiet hours it waits.
  const late = await box(t, api.url, { update: { install: true } });
  ready(late);
  process.env.VYRE_UPDATE_QUIET = "25-26";
  await late.call("update.check");
  assert.equal(fs.existsSync(path.join(late.req, "request")), false, "not in the quiet hours");
});

test("update.auto_install is a registry setting: off by default, kept under update.install in config.json", async t => {
  const api = await releasesApi(t, { value: [] });
  const b = await box(t, api.url);
  const schema = (await b.call("settings.schema")).data;
  const def = schema.keys.find(k => k.key === "update.auto_install");
  assert.ok(def, "declared");
  assert.equal(def.default, false);
  assert.equal(def.label, "Update automatically");
  const set = await b.call("settings.set", { key: "update.auto_install", value: true });
  assert.ok(!set.error, JSON.stringify(set.error));
  assert.equal(JSON.parse(fs.readFileSync(path.join(b.root, "config.json"), "utf8")).update.install, true);
  assert.equal((await b.call("update.status")).data.install, true);
});
