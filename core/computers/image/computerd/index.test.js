// @ts-check
// computerd itself, spawned with a fake token and a fake Chrome (testing/fake-chrome.js, reached
// through a small wrapper script since CHROME_BIN must be an executable): Chrome's flags, the
// /cdp/json/version shape, a WebSocket round trip through hands-chrome's own client, the token
// and shield checks on the upgrade, the fill token, and a Chrome restart. All in a temp dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  assert.ok(!seen.args.some(a => a.startsWith("--proxy-pac-url")), "no PAC unless one is set");
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

test("computerd: a PAC that is not a PAC data: URL stops computerd; a real one reaches Chrome's flags", async t => {
  await assert.rejects(computerd(t, { VYRE_PROXY_PAC: "data:application/x-ns-proxy-autoconfig;base64,AAAA --evil" }), /exited 1/);
  const pac = "data:application/x-ns-proxy-autoconfig;base64,ZnVuY3Rpb24gRmluZFByb3h5Rm9yVVJMKCl7fQ==";
  const c = await computerd(t, { VYRE_PROXY_PAC: pac });
  const seen = JSON.parse(fs.readFileSync(path.join(c.profile, "fake-chrome.json"), "utf8"));
  assert.ok(seen.args.includes(`--proxy-pac-url=${pac}`));
  assert.ok(seen.args.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"));
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
