// @ts-check
// `vyre connect apps` and `vyre connect add app` as a person runs them: the real `vyre` binary in a
// child process against a real vyred in a temp home, a fake authorization server and a fake MCP
// server. Never a real vendor, browser or terminal prompt.

import { test } from "node:test";

// Presets for fakes on this machine are honoured only under this switch (production reads the shipped catalog).
process.env.VYRE_CONNECTORS_TEST_PRESETS = "1";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { tempHome, present } from "../../../test/helpers.js";
import { startFakeMcpHttp } from "../../mcp/testing/fake-mcp.js";
import { startFakeAuthServer } from "../../connectors/testing/fake-oauth.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "..", "..", "bin", "vyre");

const run = (root, args) => new Promise(resolve => {
  const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" } });
  let out = "", err = "";
  p.stdout.on("data", c => { out += c; });
  p.stderr.on("data", c => { err += c; });
  p.on("close", code => resolve({ code, out, err, all: out + err }));
  p.stdin.end();
});

function live(root, args) {
  const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" } });
  let out = "", err = "";
  const waits = [];
  const check = () => { for (const w of [...waits]) { const hit = out.split("\n").find(l => w.re.test(l)); if (hit !== undefined) { waits.splice(waits.indexOf(w), 1); w.resolve(hit); } } };
  p.stdout.on("data", c => { out += c; check(); });
  p.stderr.on("data", c => { err += c; });
  const done = new Promise(resolve => p.on("close", code => resolve({ code, out, err, all: out + err })));
  const line = re => Promise.race([new Promise(resolve => { waits.push({ re, resolve }); check(); }), done.then(r => { throw new Error(`vyre ended before ${re}: ${r.all}`); })]);
  return { p, line, done };
}

async function world(t) {
  const auth = await startFakeAuthServer(t, { dcr: true });
  const mcp = await startFakeMcpHttp(t, { protectedBy: auth.origin, requireAuth: h => Boolean(h) && auth.tokens.has(String(h).replace(/^Bearer /, "")) });
  const noreg = await startFakeAuthServer(t, { dcr: false });
  const root = tempHome(t);
  const base = { label: "Fake", group: "work", transport: "http", who: "Anyone.", evidence: "docs" };
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" }, connectors: { presets: [
    { ...base, id: "fakevendor", url: mcp.url, oauth: { client: "dcr" } },
    { ...base, id: "ownapp", url: `${noreg.origin}/mcp`, oauth: { client: "byo", help: "Make an app.", port: 53681 } },
  ] } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  return { auth, mcp, root, d };
}

test("connect apps lists the catalog, the connected ones and the vendors ruled out", async t => {
  const w = await world(t);
  const r = await run(w.root, ["connect", "apps", "--all"]);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /ghl\s+GoHighLevel/);
  assert.match(r.out, /fakevendor/);
  assert.match(r.out, /dropbox\s+Dropbox\s+cannot be connected: /);
  const j = JSON.parse((await run(w.root, ["connect", "apps", "--json"])).out);
  assert.ok(j.presets.some(p => p.id === "ghl" && p.setup === "none"));
});

test("connect add app: the sign-in address, the pasted address, then the tools", async t => {
  const w = await world(t);
  const c = live(w.root, ["connect", "add", "app", "fakevendor"]);
  const url = (await c.line(/^https?:\/\//)).trim();
  c.p.stdin.write(w.auth.consent(url) + "\n");
  const r = await c.done;
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /connected fakevendor\s+\d+ tools/);
  const list = await run(w.root, ["connect", "list"]);
  assert.match(list.out, /fakevendor\s+mcp http/);
  // disconnecting takes the record and the hub row
  const rm = await run(w.root, ["connect", "remove", "fakevendor"]);
  assert.equal(rm.code, 0, rm.all);
  assert.match((await run(w.root, ["connect", "list"])).out, /nothing connected yet/);
});

test("connect add app: an app that needs your own OAuth app says how, and a token needs a terminal", async t => {
  const w = await world(t);
  const r = await run(w.root, ["connect", "add", "app", "ownapp"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /needs your own OAuth app first/);
  assert.match(r.out, /http:\/\/127\.0\.0\.1:53681\/connect\/callback/);
  const g = await run(w.root, ["connect", "add", "app", "ghl", "--mode", "token"]);
  assert.equal(g.code, 2);
  assert.match(g.all, /needs a token, typed at a hidden prompt/);
  const slack = await run(w.root, ["connect", "add", "app", "dropbox"]);
  assert.equal(slack.code, 1);
  assert.match(slack.all, /Dropbox cannot be connected/);
});
