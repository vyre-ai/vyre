// @ts-check
// The onboarding as a browser meets it: a real vyred in a temp home, the one-time link from the
// socket, the loopback listener, the cookie, and only the onboarding tools behind it. Tailscale
// and claude are fake binaries; nothing here reaches the real ones.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";
import { tempHome } from "./helpers.js";

/** A fake executable that prints `out` for any arguments. */
function fakeBin(dir, name, out) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\ncat <<'EOF'\n${out}\nEOF\n`, { mode: 0o755 });
  return p;
}

async function box(t) {
  const root = tempHome(t);
  const bins = fs.mkdtempSync(path.join(root, "bin-"));
  const env = { VYRE_TAILSCALE_BIN: process.env.VYRE_TAILSCALE_BIN, VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, CLOUDFLARE_VYRE_TOKEN: process.env.CLOUDFLARE_VYRE_TOKEN };
  process.env.VYRE_TAILSCALE_BIN = fakeBin(bins, "tailscale", JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/fake", TUN: true }));
  process.env.VYRE_CLAUDE_BIN = fakeBin(bins, "claude", "2.1.0 (Claude Code)");
  delete process.env.CLOUDFLARE_VYRE_TOKEN;
  // Port 0: the first free port, so parallel test files never collide on 7300.
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], network: { onboardPort: 0 } }));
  const d = await start({ root, log: () => {} });
  t.after(async () => {
    await d.stop();
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  return { root, d };
}

/** Exchange the one-time link for the session cookie, the way a browser does. */
async function redeem(url) {
  const r = await fetch(url, { redirect: "manual" });
  return { status: r.status, location: r.headers.get("location"), cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
}

const tool = (base, cookie, name, input = {}, headers = {}) => fetch(`${base}/v1/tools/${name}`, {
  method: "POST", headers: { "content-type": "application/json", cookie, ...headers }, body: JSON.stringify(input) });

test("onboard: the link works once, becomes a cookie, and the cookie reaches only the onboarding", async t => {
  const { root } = await box(t);
  const link = await call("onboard.link", {}, { root });
  assert.ok(link.data, JSON.stringify(link.error));
  const { url, port } = link.data;
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/onboard\?t=[A-Za-z0-9_-]{40,}$/);
  const base = `http://127.0.0.1:${port}`;

  assert.equal((await fetch(`${base}/onboard`)).status, 403, "nothing is served without the token or cookie");
  const first = await redeem(url);
  assert.equal(first.status, 302);
  assert.equal(first.location, "/onboard", "the token leaves the address bar");
  assert.match(first.cookie, /^vyre_onboard=/);
  assert.equal((await redeem(url)).status, 403, "the link is single use");

  const s = await (await tool(base, first.cookie, "onboard.status")).json();
  assert.equal(s.data.mode, "loopback");
  assert.equal(s.data.current, "you");
  assert.equal(s.data.steps.claude.installed, true);
  assert.equal(s.data.steps.claude.version, "2.1.0 (Claude Code)");
  assert.equal(s.data.steps.tailscale.state, "working");
  assert.equal(s.data.steps.tailscale.loginUrl, "https://login.tailscale.com/a/fake");
  assert.equal(s.data.steps.address.state, "blocked");

  // Everything that is not the onboarding is closed, even with the cookie.
  assert.equal((await tool(base, first.cookie, "onboard.link")).status, 404, "only the socket mints links");
  assert.equal((await tool(base, first.cookie, "system.echo", { text: "x" })).status, 404);
  assert.equal((await fetch(`${base}/v1/events`, { headers: { cookie: first.cookie } })).status, 404);
  assert.equal((await fetch(`${base}/v1/health`, { headers: { cookie: first.cookie } })).status, 404);
  const listed = await (await fetch(`${base}/v1/tools`, { headers: { cookie: first.cookie } })).json();
  assert.ok(listed.error || listed.data.every(x => x.name.startsWith("onboard.") || ["projects.catalog", "projects.create", "recall.status"].includes(x.name)));
});

test("onboard: the loopback listener refuses other hosts, forms and other origins", async t => {
  const { root } = await box(t);
  const { url, port } = (await call("onboard.link", {}, { root })).data;
  const base = `http://127.0.0.1:${port}`;
  const { cookie } = await redeem(url);
  // fetch will not send a forged Host, so this one goes by hand.
  const rebound = await new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port, path: "/onboard", headers: { cookie, host: `evil.example:${port}` } },
    res => { res.resume(); resolve(res.statusCode); }).on("error", reject));
  assert.equal(rebound, 421, "a rebinding page's Host is refused");
  const form = await fetch(`${base}/v1/tools/onboard.skip`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "step=you" });
  assert.equal(form.status, 415);
  const cross = await tool(base, cookie, "onboard.skip", { step: "you" }, { origin: "https://evil.example" });
  assert.equal(cross.status, 403);
});

test("onboard: skipping, a missing vault and a missing token all say why", async t => {
  const { root } = await box(t);
  const { url, port } = (await call("onboard.link", {}, { root })).data;
  const base = `http://127.0.0.1:${port}`;
  const { cookie } = await redeem(url);
  const skipped = await (await tool(base, cookie, "onboard.skip", { step: "you" })).json();
  assert.equal(skipped.data.steps.you.state, "skipped");
  assert.equal(skipped.data.current, "claude");
  const bad = await (await tool(base, cookie, "onboard.claude", { kind: "api-key", token: "nope" })).json();
  assert.match(bad.error.message, /does not look like/);
  const fine = "sk-ant-api" + "0".repeat(40);
  const noVault = await (await tool(base, cookie, "onboard.claude", { kind: "api-key", token: fine })).json();
  assert.match(noVault.error.message, /vault is not running/);
  assert.ok(!JSON.stringify(noVault).includes(fine), "the token never comes back");
  const check = await (await tool(base, cookie, "onboard.name", { name: "alex" })).json();
  assert.equal(check.data.valid, true);
  assert.equal(check.data.available, false);
  assert.match(check.data.why, /CLOUDFLARE_VYRE_TOKEN/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).name, undefined, "an unchecked name is not saved");
});

test("onboard: a new link voids the old unredeemed one; the owner arriving on the tailnet closes the door", async t => {
  const { root, d } = await box(t);
  const a = (await call("onboard.link", {}, { root })).data;
  const b = (await call("onboard.link", {}, { root })).data;
  assert.equal(a.port, b.port);
  assert.equal((await redeem(a.url)).status, 403);
  const { cookie } = await redeem(b.url);
  assert.equal((await tool(`http://127.0.0.1:${b.port}`, cookie, "onboard.status")).status, 200);
  d.events.emit("names", "owner.seen", {});
  await new Promise(r => setTimeout(r, 100));
  assert.equal(await fetch(`http://127.0.0.1:${b.port}/onboard`).then(() => "open", () => "closed"), "closed");
});
