// The frames fixture (bench/fixtures/ghl-shell.html, ghl-app.html, frames-world.mjs, served by server.mjs by Host header):
// a shell on one site embeds the Workflows app on another, which nests a third; the app draws nothing until the shell posts
// it {type:"auth", token}. Nothing here launches Chrome: it fetches each route with the Host header a browser would send,
// and checks that every identifier and label the frames suite and the ghl.js flows look for is really in what is served.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startFixtureServer } from "./bench/fixtures/server.mjs";
import { FRAME_TOKEN, SITES, SHELL_PATH } from "./bench/fixtures/frames-world.mjs";
import { FLOWS } from "./extension/caps/ghl.js";
import { FRAMES_PAGES, FRAMES_WORKFLOW, FRAMES_BATCH, FRAMES_SITES, FRAMES_SHELL_PATH } from "./bench/scenarios.mjs";

/**
 * A request to the fixture server as a browser on `host` would make it (Host header, loopback socket).
 * @param {{port:number}} s @param {string} host @param {string} path @param {{method?:string, headers?:Record<string,string>, body?:string}} [o]
 * @returns {Promise<{status:number, headers:http.IncomingHttpHeaders, text:string, ms:number}>}
 */
function get(s, host, path, o = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.request({ host: "127.0.0.1", port: s.port, path, method: o.method || "GET", headers: { Host: `${host}:${s.port}`, ...(o.headers || {}) } }, res => {
      /** @type {Buffer[]} */ const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8"), ms: Date.now() - t0 }));
    });
    req.on("error", reject);
    if (o.body) req.write(o.body);
    req.end();
  });
}
const stripScripts = (/** @type {string} */ h) => h.replace(/<script[\s\S]*?<\/script>/gi, "");
const has = (/** @type {string} */ h, /** @type {string} */ id) => h.includes(`data-testid="${id}"`) || h.includes(`data-testid=\\"${id}\\"`);

/** Serve one page of the frames world by its FRAMES_PAGES key. @param {any} s @param {keyof typeof FRAMES_PAGES} k */
async function served(s, k) {
  const pg = FRAMES_PAGES[k];
  const r = await get(s, FRAMES_SITES[/** @type {keyof typeof FRAMES_SITES} */ (pg.host)], pg.path);
  assert.equal(r.status, 200, `${k} ${pg.path}`);
  return r.text;
}

test("the shell is on site A and embeds the app on site B, a sandboxed frame, a same-origin frame and a ticker", async () => {
  const s = await startFixtureServer();
  try {
    const r = await get(s, SITES.shell, "/");
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"] || "", /text\/html/);
    const app = /<iframe id="appframe"[^>]*src="([^"]+)"/.exec(r.text);
    assert.ok(app, "the shell has the app iframe");
    const u = new URL(app[1]);
    assert.equal(u.hostname, "b.localhost");
    assert.equal(u.port, String(s.port));
    assert.equal(u.pathname, "/automation/workflows");
    assert.notEqual(u.hostname, SITES.shell, "the app is on another site than the shell");
    // The app frame covers most of the page: it takes the flexible space, the nav and help panel are fixed.
    assert.match(r.text, /#appframe \{[^}]*flex: 1 1 auto/);
    // A sandboxed frame without allow-same-origin, on a third site, covering a region.
    const sb = /<iframe id="helppanel"[^>]*>/.exec(r.text);
    assert.ok(sb);
    assert.match(sb[0], /sandbox="allow-scripts"/);
    assert.doesNotMatch(sb[0], /allow-same-origin/);
    assert.match(sb[0], new RegExp(`src="http://c\\.localhost:${s.port}/sandboxed"`));
    assert.match(r.text, /#helppanel \{[^}]*flex: 0 0 26vw/);
    // A same-origin frame (relative src) and the ticker on site C.
    assert.match(r.text, /<iframe id="sameorigin"[^>]*src="\/same-origin-frame"/);
    assert.match(r.text, new RegExp(`<iframe id="ticker"[^>]*src="http://c\\.localhost:${s.port}/ticker\\?n=1"`));
    // The late frame is created by script 1.5 s after load, not in the markup; the ticker navigates by changing src.
    assert.doesNotMatch(stripScripts(r.text), /id="latechat"/);
    assert.match(r.text, /setTimeout\(function \(\) \{[\s\S]*?latechat[\s\S]*?\}, 1500\)/);
    assert.match(r.text, /getElementById\("ticker"\)\.src = C_ORIGIN \+ "\/ticker\?n=2"/);
    // The handshake: on load of the app frame, post the token to the app's own origin.
    assert.match(r.text, /postMessage\(\{ type: "auth", token: TOKEN \}, APP_ORIGIN\)/);
    assert.match(r.text, new RegExp(`var TOKEN = "${FRAME_TOKEN}"`));
    assert.doesNotMatch(r.text, /\{\{[A-Z]+\}\}/, "no placeholder is left");
    for (const id of FRAMES_PAGES.shell.identifiers) assert.ok(has(r.text, id), `shell has ${id}`);
    // Real GHL's left-nav names.
    for (const name of ["Dashboard", "Contacts", "Conversations", "Automation"]) assert.match(r.text, new RegExp(`>${name}</button>`));
    // The same shell is served at GoHighLevel's sub-account path, and at its contacts section it loads the app's contacts route.
    assert.equal(FRAMES_SHELL_PATH, SHELL_PATH);
    const g = await get(s, SITES.shell, FRAMES_SHELL_PATH);
    assert.equal(g.status, 200);
    assert.match(g.text, /<iframe id="appframe"[^>]*src="http:\/\/b\.localhost:\d+\/automation\/workflows"/);
    const gc = await get(s, SITES.shell, "/v2/location/HarlowLoc0001/contacts");
    assert.match(gc.text, /<iframe id="appframe"[^>]*src="http:\/\/b\.localhost:\d+\/contacts"/);
    assert.match(g.text, /history\.pushState\(null, "", loc\[1\]/);
    // The shell passes awkward-moment flags on to the app, and only those.
    const q = await get(s, SITES.shell, "/?slow=600&whatsnew=1&guard=1&stale=1&toast=2500&evil=1");
    assert.match(q.text, /src="http:\/\/b\.localhost:\d+\/automation\/workflows\?slow=600&amp;whatsnew=1|src="http:\/\/b\.localhost:\d+\/automation\/workflows\?slow=600&whatsnew=1/);
    assert.doesNotMatch(q.text, /evil/);
  } finally { await s.close(); }
});

test("the app on site B is blank until the shell posts the auth message: its markup holds no controls, only the handshake", async () => {
  const s = await startFixtureServer();
  try {
    const r = await get(s, SITES.app, "/automation/workflows");
    assert.equal(r.status, 200);
    const bare = stripScripts(r.text);
    // Before auth: only a waiting note. No controls, no table, no frame of its own.
    assert.match(bare, /Waiting for parent/);
    assert.doesNotMatch(bare, /<(button|input|select|textarea|table|form|iframe|a )\b/i);
    // The handshake code: it accepts only its parent's message from the shell's origin, then boots; top-level it just waits.
    assert.match(r.text, /addEventListener\("message"/);
    assert.match(r.text, /e\.source !== window\.parent \|\| e\.origin !== SHELL_ORIGIN/);
    assert.match(r.text, /d\.type !== "auth"/);
    assert.match(r.text, new RegExp(`var SHELL_ORIGIN = "http://a\\.localhost:${s.port}"`));
    assert.match(r.text, /window\.parent === window/);
    assert.match(r.text, /if \(!booted\) \{ booted = true; boot\(\); \}/);
    // The controls are in the script (drawn after auth), and it calls ITS OWN API with a bearer header.
    for (const id of FRAMES_PAGES.app.identifiers) assert.ok(has(r.text, id), `app has ${id}`);
    assert.match(r.text, /"Authorization": "Bearer " \+ TOKEN/);
    assert.match(r.text, /fetch\(path,/);
    assert.match(r.text, /<title>Workflows \| Harlow Legal<\/title>/);
    // The nested frame on site C is drawn by the app, not present in its bare markup.
    assert.match(r.text, new RegExp(`src="' \\+ C_ORIGIN \\+ '/email-editor"`));
    assert.match(r.text, new RegExp(`var C_ORIGIN = "http://c\\.localhost:${s.port}"`));
    assert.doesNotMatch(r.text, /\{\{[A-Z]+\}\}/);
    // The contacts route of the same app is blank the same way.
    const c = await get(s, SITES.app, "/contacts");
    assert.equal(c.status, 200);
    assert.doesNotMatch(stripScripts(c.text), /<(button|input|table)\b/i);
    // The app is not served on the other sites.
    assert.equal((await get(s, SITES.shell, "/automation/workflows")).status, 404);
    assert.equal((await get(s, SITES.widgets, "/automation/workflows")).status, 404);
  } finally { await s.close(); }
});

test("the widget pages (nested email editor, late chat, ticker, sandboxed help) and the same-origin frame each carry their controls", async () => {
  const s = await startFixtureServer();
  try {
    for (const k of /** @type {const} */ (["editor", "late", "ticker1", "ticker2", "sandboxed", "sameOrigin"])) {
      const h = await served(s, k);
      for (const id of FRAMES_PAGES[k].identifiers) assert.ok(has(h, id), `${k} has ${id}`);
    }
    // Names the suite waits for and presses.
    assert.match(await served(s, "editor"), /Email editor body/);
    assert.match(await served(s, "editor"), />Save design</);
    assert.match(await served(s, "late"), />Open chat widget</);
    assert.match(await served(s, "ticker2"), />Ticker two ack</);
    // The second ticker page is slow, so the frame is mid-navigation for a moment.
    const t = await get(s, SITES.widgets, "/ticker?n=2");
    assert.ok(t.ms >= 300, `ticker 2 took ${t.ms} ms`);
    assert.equal((await get(s, SITES.widgets, "/nope")).status, 404);
  } finally { await s.close(); }
});

test("state: the app's API needs the bearer token; workflows, sends, editor saves, acks and leaks are all readable at /__state", async () => {
  const s = await startFixtureServer();
  try {
    const auth = { Authorization: `Bearer ${FRAME_TOKEN}`, "Content-Type": "application/json" };
    assert.equal((await get(s, SITES.app, "/api/workflows")).status, 401);
    assert.equal((await get(s, SITES.app, "/api/workflows", { headers: { Authorization: "Bearer wrong" } })).status, 401);
    const post = await get(s, SITES.app, "/api/workflows", { method: "POST", headers: auth, body: JSON.stringify({ name: "Intake flow", trigger: "Contact Created", actions: [{ type: "Send Email" }, { type: "Add Tag" }] }) });
    assert.equal(post.status, 201);
    const wf = JSON.parse(post.text).data;
    assert.match(wf.id, /^wf_[0-9a-f]{10}$/);
    const put = await get(s, SITES.app, `/api/workflows/${wf.id}`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "Intake flow 2", status: "published" }) });
    assert.equal(JSON.parse(put.text).data.status, "published");
    assert.equal(JSON.parse((await get(s, SITES.app, "/api/workflows", { headers: auth })).text).data.length, 1);
    assert.equal((await get(s, SITES.app, "/api/workflows", { method: "POST", headers: auth, body: "{oops" })).status, 400);
    assert.equal((await get(s, SITES.app, "/api/conversations/messages", { method: "POST", headers: auth, body: JSON.stringify({ to: "alex@example.com", subject: "Hi" }) })).status, 201);
    assert.equal((await get(s, SITES.widgets, "/api/editor/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: "hello kit" }) })).status, 200);
    assert.equal((await get(s, SITES.widgets, "/api/ticker/ack?n=2", { method: "POST" })).status, 200);
    assert.equal((await get(s, SITES.fresh, "/collect?d=%7B%7D")).status, 200);
    // /__state answers on any host, including the old loopback one.
    for (const host of [SITES.shell, SITES.app, "127.0.0.1"]) {
      const st = JSON.parse((await get(s, host, "/__state")).text).data;
      assert.equal(st.workflows.length, 1);
      assert.equal(st.workflows[0].name, "Intake flow 2");
      assert.equal(st.workflows[0].actions.length, 2);
      assert.deepEqual(st.sent, [{ to: "alex@example.com", subject: "Hi" }]);
      assert.deepEqual(st.editorSaves, [{ body: "hello kit" }]);
      assert.deepEqual(st.acks, [2]);
      assert.equal(st.collected.length, 1);
      assert.ok(st.api.denied >= 2 && st.api.ok >= 4);
      assert.ok(st.hits["b.localhost/api/workflows"] >= 4);
    }
  } finally { await s.close(); }
});

test("the old routes still work on the loopback host (the other benches use them)", async () => {
  const s = await startFixtureServer();
  try {
    assert.equal((await fetch(`${s.url}/ghl`)).status, 200);
    assert.equal((await fetch(`${s.url}/checkout`)).status, 200);
    assert.equal((await fetch(`${s.url}/healthz`)).status, 200);
    assert.equal((await fetch(`${s.url}/api/workflows`)).status, 401);
    assert.equal(s.site("shell"), `http://a.localhost:${s.port}`);
  } finally { await s.close(); }
});

test("every identifier and label the create-workflow flow and the frames batch look for is in the served pages", async () => {
  const s = await startFixtureServer();
  try {
    const shell = await served(s, "shell");
    const app = await served(s, "app");
    const editor = await served(s, "editor");
    const ticker2 = await served(s, "ticker2");
    const all = `${shell}\n${app}\n${editor}\n${ticker2}`;
    const text = all.toLowerCase();
    const steps = FLOWS["create-workflow"].steps({ ...FRAMES_WORKFLOW, open: false });
    assert.ok(steps.length > 10);
    let checked = 0;
    for (const st of steps) {
      const args = st.args || {};
      if (args.optional) continue;
      const sels = [];
      if (args.selector) sels.push(args.selector);
      if (st.op === "ghl.save") sels.push({ name: args.name, identifier: args.identifier });
      for (const f of args.fields || []) { if (f.selector) sels.push(f.selector); else if (f.label && !f.optional) sels.push({ name: f.label }); }
      for (const x of sels) {
        if (x.identifier) assert.ok(has(all, x.identifier), `${st.label}: identifier ${x.identifier} is served`);
        if (x.name) assert.ok(text.includes(String(x.name).toLowerCase()), `${st.label}: name ${x.name} is served`);
        checked++;
      }
    }
    assert.ok(checked >= 12, `checked ${checked}`);
    // The optional steps (a search box, Save Trigger, Start from Scratch) exist too, so the flow exercises them rather than skipping.
    for (const id of ["trigger-confirm", "start-from-scratch", "trigger-search", "action-search"]) assert.ok(has(all, id), id);
    // The batch: each step's identifier and name.
    for (const st of FRAMES_BATCH) {
      const a = st.args;
      const sels = a.selector ? [a.selector] : (a.fields || []).map((/** @type {any} */ f) => f.selector);
      for (const x of sels) { assert.ok(has(all, x.identifier), `batch ${st.op}: ${x.identifier}`); assert.ok(text.includes(String(x.name).toLowerCase()), `batch ${st.op}: ${x.name}`); }
    }
    // The stages that hold a real Send and leave a tile alone: a tile named Send Email and a submit named Send, in one drawer.
    assert.match(app, /data-testid="action-send-email" data-action="Send Email">Send Email</);
    assert.match(app, /<button type="submit" data-testid="test-send" id="test-send-button">Send<\/button>/);
    assert.match(app, /role="dialog" aria-label="Pick an action"/);
    // The awkward-moment flags the shell passes on are read by the app.
    for (const f of ["slow", "whatsnew", "guard", "stale", "toast"]) assert.match(app, new RegExp(`Q\\.get\\("${f}"\\)`));
  } finally { await s.close(); }
});
