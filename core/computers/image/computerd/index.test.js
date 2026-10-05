// @ts-check
// computerd itself, spawned with a fake token and a fake Chrome (testing/fake-chrome.js, reached
// through a small wrapper script since CHROME_BIN must be an executable): Chrome's flags, the
// /cdp/json/version shape, a WebSocket round trip through hands-chrome's own client, the token
// and shield checks on the upgrade, the fill token, and a Chrome restart. All in a temp dir.

import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "../../../../test/scratch.mjs";
import { Cdp } from "../../../../modules/hands-chrome/cdp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "fake-computerd-token-0123";
const FILL = "fill-token-for-tests-0123456789abcdef";

async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {net.AddressInfo} */ (s.address()).port;
  await new Promise(r => s.close(() => r(undefined)));
  return port;
}

/** computerd on a free port, with the fake Chrome, in a temp home. */
async function computerd(t, env = {}, { freeze = false } = {}) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "computerd-cdp-"));
  const bin = path.join(dir, "fake-chromium");
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(HERE, "testing", "fake-chrome.js")}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
  const profile = path.join(dir, "profile");
  fs.mkdirSync(profile);
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) fs.writeFileSync(path.join(profile, f), "stale");
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(HERE, "index.js")], {
    env: {
      PATH: process.env.PATH, HOME: dir, COMPUTERD_TOKEN: TOKEN, COMPUTERD_PORT: String(port), COMPUTERD_FS_ROOT: dir,
      CHROME_BIN: bin, CHROME_PROFILE: profile, SCREEN: "1280x800", VNC_PASSWORD: "vnc-secret-not-for-chrome", ...env,
    },
    // freeze: fd 9 is the freezer's pipe, as entrypoint.sh gives it (VYRE_FREEZE_FD=9).
    stdio: freeze ? ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "pipe"] : ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { out += d; });
  // computerd first, so it starts nothing more; then the temp dir.
  t.after(() => { child.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const check = () => { if (/listening/.test(out) && /pipe is up/.test(out)) resolve(undefined); };
    child.stdout.on("data", check);
    child.once("exit", code => reject(new Error(`computerd exited ${code}: ${out}`)));
    check();
  });
  // "pipe is up" is computerd's side; the fake writes down its argv a moment later.
  for (let i = 0; i < 100 && !fs.existsSync(path.join(profile, "fake-chrome.json")); i++) await new Promise(r => setTimeout(r, 50));
  return { base: `http://127.0.0.1:${port}`, port, dir, profile, child, output: () => out };
}

/** @returns {Promise<{ status: number, json: any }>} */
function req(base, method, route, { token = TOKEN, body } = /** @type {any} */ ({})) {
  return new Promise((resolve, reject) => {
    const r = http.request(new URL(route, base), { method, headers: token ? { authorization: `Bearer ${token}` } : {}, agent: false }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        resolve({ status: res.statusCode || 0, json });
      });
    });
    r.on("error", reject);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** The status a WebSocket upgrade gets: 101, or whatever it was refused with. */
function upgradeStatus(base, route) {
  return new Promise((resolve, reject) => {
    const r = http.request(new URL(route, base), {
      agent: false,
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
    });
    r.on("upgrade", (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    r.on("response", res => { res.resume(); resolve(res.statusCode); });
    r.on("error", reject);
    r.end();
  });
}

/** An open WebSocket and a way to call over it. @param {string} url */
async function ws(url) {
  const sock = new WebSocket(url);
  await new Promise((resolve, reject) => { sock.onopen = resolve; sock.onerror = () => reject(new Error("WebSocket failed to open")); });
  /** @type {any[]} */
  const inbox = [];
  let closed = false;
  const closedP = new Promise(r => sock.addEventListener("close", () => { closed = true; r(undefined); }));
  sock.addEventListener("message", ev => inbox.push(JSON.parse(String(ev.data))));
  let seq = 0;
  return {
    sock, inbox, closedP, get closed() { return closed; },
    /** @param {string} method @param {any} [params] @param {string} [sessionId] */
    call(method, params = {}, sessionId) {
      const id = ++seq;
      sock.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no answer to ${method}`)), 3000);
        const look = () => {
          const hit = inbox.find(m => m.id === id);
          if (hit) { clearTimeout(t); sock.removeEventListener("message", look); resolve(hit); }
        };
        sock.addEventListener("message", look);
      });
    },
  };
}

test("computerd: starts Chrome on a pipe with the image's flags, and answers /cdp/json/version in Chrome's shape", async t => {
  const c = await computerd(t);
  const seen = JSON.parse(fs.readFileSync(path.join(c.profile, "fake-chrome.json"), "utf8"));
  assert.ok(seen.args.includes("--remote-debugging-pipe"));
  assert.ok(!seen.args.some(a => a.startsWith("--remote-debugging-port") || a.startsWith("--remote-debugging-address")), "no port at all");
  for (const flag of ["--no-sandbox", "--test-type", "--disable-gpu", "--disable-dev-shm-usage", "--force-renderer-accessibility", "--disable-extensions", "--password-store=basic", "--start-maximized", `--user-data-dir=${c.profile}`, "--window-size=1280,800"]) {
    assert.ok(seen.args.includes(flag), flag);
  }
  assert.equal(seen.args.at(-1), "about:blank");
  assert.ok(!seen.env.includes("COMPUTERD_TOKEN") && !seen.env.includes("VNC_PASSWORD"), "Chrome does not inherit computerd's secrets");
  assert.ok(fs.existsSync(path.join(c.dir, ".chromium.log")), "Chrome's output goes to its log file");
  assert.ok(!fs.existsSync(path.join(c.profile, "SingletonSocket")) && !fs.existsSync(path.join(c.profile, "SingletonCookie")), "stale Singleton locks are removed before Chrome starts");

  const v = await req(c.base, "GET", "/cdp/json/version");
  assert.equal(v.status, 200);
  assert.equal(v.json.Browser, "Chrome/140.0.0.0");
  assert.equal(v.json["Protocol-Version"], "1.3");
  assert.equal(v.json["User-Agent"], "Mozilla/5.0 FakeChrome");
  assert.match(v.json.webSocketDebuggerUrl, new RegExp(`^ws://127\\.0\\.0\\.1:${c.port}/cdp/devtools/browser/[0-9a-f-]{36}$`));
  assert.equal((await req(c.base, "GET", "/cdp/json/version")).json.webSocketDebuggerUrl, v.json.webSocketDebuggerUrl, "the browser id is stable");
  assert.equal((await req(c.base, "GET", "/cdp/json/version", { token: "wrong" })).status, 401);
  const health = await req(c.base, "GET", "/health");
  assert.equal(health.json.chrome.Browser, "Chrome/140.0.0.0");
});

test("computerd: hands-chrome's own client round-trips through the mux; bad tokens and paths are refused", async t => {
  const c = await computerd(t);
  const cdp = new Cdp({ cdpUrl: `${c.base}/cdp`, token: TOKEN });
  t.after(() => cdp.close());
  const sid = await cdp.page();
  assert.ok(sid);
  const r = await cdp.send("Test.echo", { n: 42 }, sid);
  assert.deepEqual(r.echo, { n: 42 });
  await assert.rejects(cdp.send("Browser.close"), /not allowed/);

  const { json } = await req(c.base, "GET", "/cdp/json/version");
  const wsPath = new URL(json.webSocketDebuggerUrl).pathname;
  assert.equal(await upgradeStatus(c.base, `${wsPath}?token=wrong`), 401);
  assert.equal(await upgradeStatus(c.base, wsPath), 401);
  assert.equal(await upgradeStatus(c.base, `/cdp/devtools/browser/not-the-id?token=${TOKEN}`), 404);
  assert.equal(await upgradeStatus(c.base, `/cdp/devtools/page/T1?token=${TOKEN}`), 404);
  assert.ok(!c.output().includes(TOKEN), "the token never reaches computerd's output");
});

test("computerd: the shield cuts agent sockets, refuses new ones with 423, and the fill token works only while set", async t => {
  const c = await computerd(t);
  const { json } = await req(c.base, "GET", "/cdp/json/version");
  const wsUrl = json.webSocketDebuggerUrl;
  const wsPath = new URL(wsUrl).pathname;

  // Before any shield, the fill token opens nothing.
  assert.equal(await upgradeStatus(c.base, `${wsPath}?token=${FILL}`), 401);
  assert.equal((await req(c.base, "GET", "/cdp/json/version", { token: FILL })).status, 401);

  const agent = await ws(`${wsUrl}?token=${TOKEN}`);
  assert.ok((await agent.call("Browser.getVersion")).result);

  assert.equal((await req(c.base, "POST", "/shield", { body: { on: false, fill_token: FILL } })).status, 400, "a fill token needs on: true");
  assert.equal((await req(c.base, "POST", "/shield", { body: { on: true, fill_token: "short" } })).status, 400, "and 32 characters");
  assert.equal((await req(c.base, "POST", "/shield", { token: FILL, body: { on: true } })).status, 401);

  const up = await req(c.base, "POST", "/shield", { body: { on: true, reason: "sign-in", fill_token: FILL } });
  assert.deepEqual(up.json, { shielded: true, frozen: false }, "no freezer in this test");
  await agent.closedP;
  assert.equal(await upgradeStatus(c.base, `${wsPath}?token=${TOKEN}`), 423);
  assert.equal((await req(c.base, "GET", "/cdp/json/version")).status, 423);

  // The fill token: /cdp/json/version and the upgrade, and nothing else.
  assert.equal((await req(c.base, "GET", "/cdp/json/version", { token: FILL })).status, 200);
  for (const [m, r] of [["GET", "/health"], ["GET", "/fs/list?path="], ["POST", "/shield"], ["GET", "/screenshot"]]) {
    assert.equal((await req(c.base, m, r, { token: FILL, body: m === "POST" ? { on: false } : undefined })).status, 401, `${m} ${r}`);
  }
  const fill = await ws(`${wsUrl}?token=${FILL}`);
  const { result: { targetInfos } } = await fill.call("Target.getTargets");
  const at = await fill.call("Target.attachToTarget", { targetId: targetInfos[0].targetId, flatten: true });
  assert.ok((await fill.call("Test.echo", { n: 1 }, at.result.sessionId)).result);

  assert.deepEqual((await req(c.base, "POST", "/shield", { body: { on: false } })).json, { shielded: false, frozen: false });
  await fill.closedP;
  assert.equal(await upgradeStatus(c.base, `${wsPath}?token=${FILL}`), 401, "the fill token is forgotten");
  assert.equal(await upgradeStatus(c.base, `${wsPath}?token=${TOKEN}`), 101, "and the agent is let back in");
  assert.ok(!c.output().includes(FILL));
});

test("computerd: Chrome exiting fails the call in flight, and Chrome is started again", async t => {
  const c = await computerd(t);
  const { json } = await req(c.base, "GET", "/cdp/json/version");
  const first = JSON.parse(fs.readFileSync(path.join(c.profile, "fake-chrome.json"), "utf8")).pid;
  const a = await ws(`${json.webSocketDebuggerUrl}?token=${TOKEN}`);
  const dying = await a.call("Test.exit");
  assert.equal(dying.error.code, -32000);
  await a.closedP;
  // Back after the first backoff (1 s).
  const deadline = Date.now() + 5000;
  let v;
  while (Date.now() < deadline) {
    v = await req(c.base, "GET", "/cdp/json/version");
    if (v.status === 200) break;
    assert.equal(v.status, 503);
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(/** @type {any} */ (v).status, 200);
  const second = JSON.parse(fs.readFileSync(path.join(c.profile, "fake-chrome.json"), "utf8")).pid;
  assert.notEqual(second, first);
  const b = await ws(`${json.webSocketDebuggerUrl}?token=${TOKEN}`);
  assert.ok((await b.call("Browser.getVersion")).result);
  b.sock.close();
});

test("computerd: the shield tells the freezer to stop the agent's processes, and to continue them when it comes down", async t => {
  const c = await computerd(t, { VYRE_FREEZE_FD: "9" }, { freeze: true });
  const pipe = /** @type {import("node:stream").Readable} */ (c.child.stdio[9]);
  let got = "";
  pipe.on("data", d => { got += d; });
  const until = async text => { for (let i = 0; i < 100 && !got.includes(text); i++) await new Promise(r => setTimeout(r, 20)); };
  assert.deepEqual((await req(c.base, "POST", "/shield", { body: { on: true } })).json, { shielded: true, frozen: true });
  await until("stop\n");
  assert.deepEqual((await req(c.base, "POST", "/shield", { body: { on: false } })).json, { shielded: false, frozen: true });
  await until("cont\n");
  assert.equal(got, "stop\ncont\n");
});

test("computerd: the token comes from COMPUTERD_TOKEN_FILE (the .boot file), never from its environment in the image", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "computerd-boot-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fileToken = "F".repeat(43);
  const boot = path.join(dir, ".boot");
  fs.writeFileSync(boot, `COMPUTERD_TOKEN=${fileToken}\nVNC_PASSWORD=Ab-_1234\n`, { mode: 0o400 });
  // The file wins over a stale COMPUTERD_TOKEN, which the image never sets.
  const c = await computerd(t, { COMPUTERD_TOKEN_FILE: boot });
  assert.equal((await req(c.base, "GET", "/cdp/json/version", { token: fileToken })).status, 200);
  assert.equal((await req(c.base, "GET", "/cdp/json/version")).status, 401, "the environment's token is not the one");
  assert.ok(!c.output().includes(fileToken) && !c.output().includes("Ab-_1234"), "a secret reached the log");
});

// ---- per-agent identity (agent-browsers.md level 2, a shared computer) ----------------------
// AGENT_TOKENS_FILE (mirrored here by the raw AGENT_TOKENS env, the file-vs-env split
// COMPUTERD_TOKEN_FILE already has): "name=token" pairs, one per line. Any pair at all switches
// the computer into shared mode, where the bare owner token (TOKEN/COMPUTERD_TOKEN) no longer
// answers as an agent's own CDP identity -- only a listed per-agent token does, and computerd is
// the one that says which name that token belongs to, never the connecting client.

const ALICE = "alice-token-0123456789abcdefghijklmn";
const BOB = "bob-token-0123456789abcdefghijklmnop";

/** Spawn computerd expecting it to exit before ever becoming ready (a malformed AGENT_TOKENS_FILE). */
async function computerdRefusesToStart(t, env) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "computerd-badboot-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(HERE, "index.js")], {
    env: { PATH: process.env.PATH, HOME: dir, COMPUTERD_TOKEN: TOKEN, COMPUTERD_PORT: String(port), COMPUTERD_FS_ROOT: dir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { out += d; });
  const code = await new Promise(resolve => child.once("exit", resolve));
  return { code, out };
}

test("computerd: two agents sharing one computer each get their own CDP identity, and neither can reach the other's context", async t => {
  const c = await computerd(t, { AGENT_TOKENS: `alice-1:alice=${ALICE}\nbob-1:bob=${BOB}` });
  const wsUrlFor = async token => {
    const { json } = await req(c.base, "GET", "/cdp/json/version", { token });
    return `${c.base}${new URL(json.webSocketDebuggerUrl).pathname}?token=${token}`;
  };
  const alice = await ws(await wsUrlFor(ALICE));
  const bob = await ws(await wsUrlFor(BOB));
  const { result: aCreate } = await alice.call("Target.createTarget", { url: "about:blank#alice" });
  const { result: bCreate } = await bob.call("Target.createTarget", { url: "about:blank#bob" });
  assert.ok(aCreate.targetId && bCreate.targetId);

  // Wait on the real condition (a target shows up in its owner's own list), not on time: on a slow runner the list lags the create.
  const listOf = async (client, want) => {
    let ids = [];
    for (const end = Date.now() + 10_000; Date.now() < end;) {
      ids = (await client.call("Target.getTargets")).result.targetInfos.map(t => t.targetId);
      if (ids.includes(want)) break;
      await new Promise(r => setTimeout(r, 50));
    }
    return ids;
  };
  const aTargets = await listOf(alice, aCreate.targetId);
  const bTargets = await listOf(bob, bCreate.targetId);
  assert.ok(aTargets.includes(aCreate.targetId), "alice cannot see her own target");
  assert.ok(!aTargets.includes(bCreate.targetId), "alice can see bob's target");
  assert.ok(bTargets.includes(bCreate.targetId), "bob cannot see his own target");
  assert.ok(!bTargets.includes(aCreate.targetId), "bob can see alice's target");

  const cross = await alice.call("Target.closeTarget", { targetId: bCreate.targetId });
  assert.equal(cross.error && cross.error.code, -32000, "alice could close bob's target");
});

test("computerd: POST /agents/reload revokes a removed agent's live CDP clients, leaves the others untouched, and is owner-token only (reviewer gate item 3, 28 Sep)", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "computerd-revoke-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokensFile = path.join(dir, "agent-tokens");
  fs.writeFileSync(tokensFile, `alice-1:alice=${ALICE}\nbob-1:bob=${BOB}\n`);
  const c = await computerd(t, { AGENT_TOKENS_FILE: tokensFile });
  const wsUrlFor = async token => {
    const { json } = await req(c.base, "GET", "/cdp/json/version", { token });
    return `${c.base}${new URL(json.webSocketDebuggerUrl).pathname}?token=${token}`;
  };
  const alice = await ws(await wsUrlFor(ALICE));
  const bob = await ws(await wsUrlFor(BOB));
  assert.ok((await bob.call("Target.getTargets")).result, "bob's own connection is not live before revocation");

  // Not the computer's own owner token: refused, and nothing changes.
  assert.equal((await req(c.base, "POST", "/agents/reload", { token: ALICE })).status, 401, "an agent's own token could reload");
  assert.equal(bob.closed, false, "bob was dropped by a call that was itself refused");

  // Bob is taken off the computer: rewrite the file without him, then reload as the owner.
  fs.writeFileSync(tokensFile, `alice-1:alice=${ALICE}\n`);
  const r = await req(c.base, "POST", "/agents/reload", { token: TOKEN });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { agents: 1, revoked: ["bob-1"] });
  await bob.closedP;
  assert.equal(bob.closed, true, "bob's own live WebSocket was not closed by revocation");
  // Alice is untouched: her own connection, made before the reload, still answers.
  assert.ok((await alice.call("Target.getTargets")).result, "alice was dropped even though she was not revoked");
  // Neither can open a NEW session with bob's now-revoked token; alice's own still works.
  const { json: stillAlice } = await req(c.base, "GET", "/cdp/json/version", { token: ALICE });
  const wsPath = new URL(stillAlice.webSocketDebuggerUrl).pathname;
  assert.equal(await upgradeStatus(c.base, `${wsPath}?token=${BOB}`), 401, "bob's revoked token could still open a new session");
  assert.equal(await upgradeStatus(c.base, `${wsPath}?token=${ALICE}`), 101, "alice, never revoked, could not open a new session");
});

test("computerd: reloading a rotated (not just removed) agent's token also cuts the old live session", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "computerd-rotate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokensFile = path.join(dir, "agent-tokens");
  fs.writeFileSync(tokensFile, `alice-1:alice=${ALICE}\n`);
  const c = await computerd(t, { AGENT_TOKENS_FILE: tokensFile });
  const { json } = await req(c.base, "GET", "/cdp/json/version", { token: ALICE });
  const wsPath = new URL(json.webSocketDebuggerUrl).pathname;
  const alice = await ws(`${c.base}${wsPath}?token=${ALICE}`);
  assert.ok((await alice.call("Target.getTargets")).result);

  const rotated = "a".repeat(40); // a fresh token for the same name
  fs.writeFileSync(tokensFile, `alice-1:alice=${rotated}\n`);
  const r = await req(c.base, "POST", "/agents/reload", { token: TOKEN });
  assert.deepEqual(r.json, { agents: 1, revoked: ["alice-1"] }, "a rotation is not a no-op just because the name survived");
  await alice.closedP;
  assert.equal(alice.closed, true, "the old session, on the now-rotated-away token, was not closed");

  const alice2 = await ws(`${c.base}${wsPath}?token=${rotated}`);
  assert.ok((await alice2.call("Target.getTargets")).result, "the new token could not open a session after rotation");
  assert.equal(await upgradeStatus(c.base, `${wsPath}?token=${ALICE}`), 401, "the old token still worked after rotation");
});

test("computerd: an empty or missing reload is refused, not applied -- shared mode is kept and nobody is revoked by a stray truncated file (reviewer revocation point 1, 28 Sep)", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "computerd-emptyreload-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokensFile = path.join(dir, "agent-tokens");
  fs.writeFileSync(tokensFile, `alice-1:alice=${ALICE}\n`);
  const c = await computerd(t, { AGENT_TOKENS_FILE: tokensFile });
  const { json } = await req(c.base, "GET", "/cdp/json/version", { token: ALICE });
  const wsPath = new URL(json.webSocketDebuggerUrl).pathname;
  const alice = await ws(`${c.base}${wsPath}?token=${ALICE}`);

  fs.writeFileSync(tokensFile, "");
  const r1 = await req(c.base, "POST", "/agents/reload", { token: TOKEN });
  assert.equal(r1.status, 400, "an empty file's reload was applied instead of refused");
  assert.ok(!alice.closed, "alice was revoked by an empty-file reload");
  assert.ok((await alice.call("Target.getTargets")).result, "alice's session broke after a refused reload");

  fs.rmSync(tokensFile);
  const r2 = await req(c.base, "POST", "/agents/reload", { token: TOKEN });
  assert.equal(r2.status, 400, "a missing file's reload was applied instead of refused");
  assert.ok(!alice.closed, "alice was revoked by a missing-file reload");

  // Shared mode itself is kept throughout: the bare owner token still cannot open a CDP session.
  assert.equal(await upgradeStatus(c.base, `${wsPath}?token=${TOKEN}`), 401, "the owner token became an unscoped agent identity after an empty/missing reload");
  assert.equal(await upgradeStatus(c.base, `${wsPath}?token=${ALICE}`), 101, "alice's own (never-changed) token stopped working");
});

test("computerd: a reload with a badly-shaped line is refused (not a fatal exit) and the previous map is kept", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "computerd-badreload-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokensFile = path.join(dir, "agent-tokens");
  fs.writeFileSync(tokensFile, `alice-1:alice=${ALICE}\n`);
  const c = await computerd(t, { AGENT_TOKENS_FILE: tokensFile });
  fs.writeFileSync(tokensFile, "this is not name=token shaped at all");
  const r = await req(c.base, "POST", "/agents/reload", { token: TOKEN });
  assert.equal(r.status, 400);
  // computerd is still up and alice's own token is still exactly as valid as before.
  const { json } = await req(c.base, "GET", "/cdp/json/version", { token: ALICE });
  assert.ok(json && json.webSocketDebuggerUrl, "computerd stopped answering after a bad reload");
});

test("computerd: POST /agents/dispose is the separate, explicit deletion action -- owner-token only, does not itself close a live client, and reports whether a context existed at all", async t => {
  const c = await computerd(t, { AGENT_TOKENS: `alice-1:alice=${ALICE}` });
  const { json } = await req(c.base, "GET", "/cdp/json/version", { token: ALICE });
  const wsPath = new URL(json.webSocketDebuggerUrl).pathname;

  // Not the owner: refused, same class as /shield and /agents/reload.
  assert.equal((await req(c.base, "POST", "/agents/dispose", { token: ALICE, body: { id: "alice-1" } })).status, 401);
  // No body / no id: a clean 400, not a crash.
  assert.equal((await req(c.base, "POST", "/agents/dispose", { token: TOKEN, body: {} })).status, 400);

  const alice = await ws(`${c.base}${wsPath}?token=${ALICE}`);
  const r = await req(c.base, "POST", "/agents/dispose", { token: TOKEN, body: { id: "alice-1" } });
  assert.equal(r.status, 200);
  // Nothing about the context has been created yet in this test (no CDP call was made that would
  // trigger _contextFor) -- disposed is false, and that itself is the "reports whether one
  // existed" contract, not a failure.
  assert.equal(typeof r.json.disposed, "boolean");
  // Disposal alone never drops a live client, and alice's own connection is still answering.
  assert.equal(alice.closed, false, "disposeAgentContext (via the route) closed a live client on its own");
  assert.ok((await alice.call("Target.getTargets")).result, "alice's connection stopped answering after disposal");
});

test("computerd: in shared mode the bare owner token is refused as a CDP identity, on the upgrade and on /cdp/json/version, though it still opens POST /shield", async t => {
  const c = await computerd(t, { AGENT_TOKENS: `alice-1:alice=${ALICE}` });
  const { json } = await req(c.base, "GET", "/cdp/json/version", { token: ALICE });
  const wsPath = new URL(json.webSocketDebuggerUrl).pathname;
  assert.equal(await upgradeStatus(c.base, `${wsPath}?token=${TOKEN}`), 401, "the owner token opened a CDP session in shared mode");
  assert.equal((await req(c.base, "GET", "/cdp/json/version", { token: TOKEN })).status, 401, "the owner token read cdp/json/version's identity-gated route");
  // But the owner token is still the computer's own control-plane secret: /shield keeps working.
  assert.equal((await req(c.base, "POST", "/shield", { token: TOKEN, body: { on: false } })).status, 200);
  // An agent's own per-agent token, by contrast, never opens /shield or /fs -- those stay owner-only.
  assert.equal((await req(c.base, "POST", "/shield", { token: ALICE, body: { on: false } })).status, 401);
  assert.equal((await req(c.base, "GET", "/fs/list?path=", { token: ALICE })).status, 401);
});

test("computerd: a computer with no AGENT_TOKENS_FILE at all is unaffected -- the owner token is still the one agent identity, exactly as before", async t => {
  const c = await computerd(t);
  const { json } = await req(c.base, "GET", "/cdp/json/version");
  const wsPath = new URL(json.webSocketDebuggerUrl).pathname;
  assert.equal(await upgradeStatus(c.base, `${wsPath}?token=${TOKEN}`), 101);
});

test("computerd: AGENT_TOKENS_FILE naming a path that does not exist is the ordinary case, not an error -- entrypoint.sh may pass it unconditionally", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "computerd-noagenttokens-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const c = await computerd(t, { AGENT_TOKENS_FILE: path.join(dir, "does-not-exist") });
  const { json } = await req(c.base, "GET", "/cdp/json/version");
  const wsPath = new URL(json.webSocketDebuggerUrl).pathname;
  assert.equal(await upgradeStatus(c.base, `${wsPath}?token=${TOKEN}`), 101, "a missing AGENT_TOKENS_FILE put the computer into shared mode");
  assert.ok(!c.output().toLowerCase().includes("could not read"), "a missing (ordinary) AGENT_TOKENS_FILE logged an error");
});

test("computerd: a malformed AGENT_TOKENS_FILE refuses to start rather than run with a partial identity list", async t => {
  for (const [why, value] of [
    ["not id:name=token shaped", "not-a-valid-line-at-all"],
    ["a duplicate id", `alice-1:alice=${ALICE}\nalice-1:alice2=${BOB}`],
    ["a duplicate token", `alice-1:alice=${ALICE}\nbob-1:bob=${ALICE}`],
    ["a name that isn't lowercase-kebab", `alice-1:Alice=${ALICE}`],
    ["a token shorter than 32 characters", "alice-1:alice=too-short"],
  ]) {
    const { code, out } = await computerdRefusesToStart(t, { AGENT_TOKENS: value });
    assert.notEqual(code, 0, `computerd started with an AGENT_TOKENS_FILE that is ${why}`);
    assert.ok(!out.includes(ALICE) && !out.includes(BOB), "a token reached the log even while refusing to start");
  }
});

test("computerd: a duplicate DISPLAY NAME across two different agent ids is fine -- names are cosmetic only, ids are the identity (reviewer + lead, 28 Sep)", async t => {
  const c = await computerd(t, { AGENT_TOKENS: `alice-1:alice=${ALICE}\nalice-2:alice=${BOB}` });
  const { json } = await req(c.base, "GET", "/cdp/json/version", { token: ALICE });
  assert.ok(json && json.webSocketDebuggerUrl, "a duplicate display name stopped computerd from starting");
  assert.equal((await req(c.base, "GET", "/cdp/json/version", { token: BOB })).status, 200);
});

// The root-launcher design (reviewer, 28 Sep): with no CHROME_BIN, computerd never spawns
// anything for Chrome -- it only opens two named FIFOs and waits, the same way it would wait on
// the image for entrypoint.sh's chrome_loop to bring Chrome up. Needs mkfifo (Linux; testbox).
test("computerd: with no CHROME_BIN, it connects to Chrome over CHROME_IN/CHROME_OUT FIFOs, and reconnects when they close", { skip: process.platform !== "linux" && "mkfifo needs Linux" }, async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "computerd-fifo-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const chromeIn = path.join(dir, "in");
  const chromeOut = path.join(dir, "out");
  execFileSync("mkfifo", [chromeIn, chromeOut]);

  const port = await freePort();
  const child = spawn(process.execPath, [path.join(HERE, "index.js")], {
    env: { PATH: process.env.PATH, HOME: dir, COMPUTERD_TOKEN: TOKEN, COMPUTERD_PORT: String(port), COMPUTERD_FS_ROOT: dir, CHROME_IN: chromeIn, CHROME_OUT: chromeOut },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { out += d; });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((resolve, reject) => {
    child.stdout.on("data", () => { if (/listening/.test(out)) resolve(undefined); });
    child.once("exit", code => reject(new Error(`computerd exited ${code}: ${out}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await req(base, "GET", "/cdp/json/version")).status, 503, "computerd answers before anything is on the FIFOs");

  // Act as Chrome, as a real separate process (a shell opening the FIFOs for its own fd 3/4, then
  // exec'ing the fake): killing it, like a real Chrome crash, gets a clean kernel-level fd close
  // rather than a stream .destroy()'s asynchronous one, which real production also gets for free
  // (Chrome exiting is a real process exit) but a same-process fake would not reliably reproduce.
  const fake = path.join(HERE, "testing", "fake-chrome.js");
  const spawnFakeChrome = () => spawn("bash", ["-c", `exec "${process.execPath}" "${fake}" --remote-debugging-pipe 3<"${chromeIn}" 4>"${chromeOut}"`], { stdio: ["ignore", "ignore", "ignore"] });
  const waitFor = async re => { for (let i = 0; i < 100 && !re.test(out); i++) await new Promise(r => setTimeout(r, 50)); assert.match(out, re); };

  const chrome1 = spawnFakeChrome();
  await waitFor(/chromium connected/);
  assert.equal((await req(base, "GET", "/cdp/json/version")).status, 200);

  // Chrome "exits": both FIFO ends close (the process is gone); computerd notices and waits.
  chrome1.kill("SIGKILL");
  await waitFor(/reconnecting in/);
  const failing = await req(base, "GET", "/cdp/json/version");
  assert.equal(failing.status, 503);

  // entrypoint.sh's chrome_loop would restart Chrome onto the same FIFO paths.
  const chrome2 = spawnFakeChrome();
  t.after(() => { try { chrome2.kill("SIGKILL"); } catch {} });
  const deadline = Date.now() + 5000;
  let v;
  while (Date.now() < deadline) {
    v = await req(base, "GET", "/cdp/json/version");
    if (v.status === 200) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(/** @type {any} */ (v).status, 200, "computerd reconnected to the next Chrome");
});
