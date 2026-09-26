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
import { bindAddress } from "../core/onboard/loopback.js";

/** A fake executable that prints `out` for any arguments. */
function fakeBin(dir, name, out) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\ncat <<'EOF'\n${out}\nEOF\n`, { mode: 0o755 });
  return p;
}

async function box(t, extra = {}) {
  const root = tempHome(t);
  const bins = fs.mkdtempSync(path.join(root, "bin-"));
  const env = { VYRE_TAILSCALE_BIN: process.env.VYRE_TAILSCALE_BIN, VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, CLOUDFLARE_VYRE_TOKEN: process.env.CLOUDFLARE_VYRE_TOKEN };
  process.env.VYRE_TAILSCALE_BIN = fakeBin(bins, "tailscale", JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/fake", TUN: true }));
  process.env.VYRE_CLAUDE_BIN = fakeBin(bins, "claude", "2.1.0 (Claude Code)");
  delete process.env.CLOUDFLARE_VYRE_TOKEN;
  // Port 0: the first free port, so parallel test files never collide on 7300.
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], network: { onboardPort: 0 }, ...extra }));
  const d = await start({ root, log: () => {} });
  t.after(async () => {
    await d.stop();
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  return { root, d };
}

/** Exchange the one-time link for the session, the way the page does: from the redirect's fragment. */
async function redeem(url) {
  const r = await fetch(url, { redirect: "manual" });
  const location = r.headers.get("location") || "";
  return { status: r.status, location, session: (location.match(/#s=([A-Za-z0-9_-]+)$/) || [])[1] || "", cookie: r.headers.get("set-cookie") };
}

const tool = (base, session, name, input = {}, headers = {}) => fetch(`${base}/v1/tools/${name}`, {
  method: "POST", headers: { "content-type": "application/json", "x-vyre-onboard": session, ...headers }, body: JSON.stringify(input) });

test("onboard: the link works once, becomes a session, and the session reaches only the onboarding", async t => {
  const { root } = await box(t);
  const link = await call("onboard.link", {}, { root });
  assert.ok(link.data, JSON.stringify(link.error));
  const { url, port } = link.data;
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/onboard\?t=[A-Za-z0-9_-]{40,}$/);
  const base = `http://127.0.0.1:${port}`;

  assert.equal((await tool(base, "", "onboard.status")).status, 403, "no tool answers without the token or session");
  const first = await redeem(url);
  assert.equal(first.status, 302);
  assert.match(first.location, /^\/onboard#s=/, "the token leaves the address bar; the session rides in the fragment");
  assert.equal(first.cookie, null, "no cookie: browsers share cookies with every other port on 127.0.0.1");
  assert.equal((await redeem(url)).status, 403, "the link is single use");
  assert.equal((await tool(base, "forged", "onboard.status")).status, 403);

  const s = await (await tool(base, first.session, "onboard.status")).json();
  assert.equal(s.data.mode, "loopback");
  assert.equal(s.data.current, "you");
  assert.equal(s.data.steps.claude.installed, true);
  assert.equal(s.data.steps.claude.version, "2.1.0 (Claude Code)");
  assert.equal(s.data.steps.tailscale.state, "working");
  assert.equal(s.data.steps.tailscale.loginUrl, "https://login.tailscale.com/a/fake");
  assert.equal(s.data.steps.address.state, "blocked");

  // Everything that is not the onboarding is closed, even with the session.
  const h = { "x-vyre-onboard": first.session };
  assert.equal((await tool(base, first.session, "onboard.link")).status, 404, "only the socket mints links");
  assert.equal((await tool(base, first.session, "system.echo", { text: "x" })).status, 404);
  assert.equal((await tool(base, first.session, "onboard.status/../../system.echo", { text: "x" })).status, 404);
  assert.equal((await fetch(`${base}/v1/events`, { headers: h })).status, 404);
  assert.equal((await fetch(`${base}/v1/health`, { headers: h })).status, 404);
  const listed = await (await fetch(`${base}/v1/tools`, { headers: h })).json();
  assert.ok(listed.error || listed.data.every(x => x.name.startsWith("onboard.") || ["projects.catalog", "projects.create", "recall.status"].includes(x.name)));
});

test("onboard: the loopback listener refuses other hosts, forms and other origins", async t => {
  const { root } = await box(t);
  const { url, port } = (await call("onboard.link", {}, { root })).data;
  const base = `http://127.0.0.1:${port}`;
  const { session } = await redeem(url);
  // fetch will not send a forged Host, so this one goes by hand.
  const rebound = await new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port, path: "/onboard", headers: { host: `evil.example:${port}` } },
    res => { res.resume(); resolve(res.statusCode); }).on("error", reject));
  assert.equal(rebound, 421, "a rebinding page's Host is refused");
  const form = await fetch(`${base}/v1/tools/onboard.skip`, { method: "POST", headers: { "x-vyre-onboard": session, "content-type": "application/x-www-form-urlencoded" }, body: "step=you" });
  assert.equal(form.status, 415);
  const cross = await tool(base, session, "onboard.skip", { step: "you" }, { origin: "https://evil.example" });
  assert.equal(cross.status, 403);
});

test("onboard: skipping, a bad token and a missing Cloudflare token all say why; a good token goes to the vault", async t => {
  const { root } = await box(t, { vault: { keystore: "file" } });
  const { url, port } = (await call("onboard.link", {}, { root })).data;
  const base = `http://127.0.0.1:${port}`;
  const { session: cookie } = await redeem(url);
  const skipped = await (await tool(base, cookie, "onboard.skip", { step: "you" })).json();
  assert.equal(skipped.data.steps.you.state, "skipped");
  assert.equal(skipped.data.current, "claude");
  const bad = await (await tool(base, cookie, "onboard.claude", { kind: "api-key", token: "nope" })).json();
  assert.match(bad.error.message, /does not look like/);
  const fine = "sk-ant-api" + "0".repeat(40);
  const stored = await (await tool(base, cookie, "onboard.claude", { kind: "api-key", token: fine })).json();
  assert.equal(stored.data.state, "done");
  assert.ok(!JSON.stringify(stored).includes(fine), "the token never comes back");
  const item = (await call("vault.list", {}, { root, caller: "cli" })).data.items.find(i => i.name === "anthropic-api-key");
  assert.equal(item.origin, "module:onboard");
  assert.ok(JSON.stringify(item.grants).includes("agents"), "the agents module may read it");
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
  const { session } = await redeem(b.url);
  assert.equal((await tool(`http://127.0.0.1:${b.port}`, session, "onboard.status")).status, 200);
  d.events.emit("names", "owner.seen", {});
  await new Promise(r => setTimeout(r, 100));
  assert.equal(await fetch(`http://127.0.0.1:${b.port}/onboard`).then(() => "open", () => "closed"), "closed");
});

test("onboard: in the box's container the listener binds the container's own address, never the tailnet's", () => {
  const ifaces = {
    lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    tailscale0: [{ family: "IPv4", address: "100.101.2.3", internal: false }],
    eth0: [{ family: "IPv6", address: "fe80::1", internal: false }, { family: "IPv4", address: "172.20.0.2", internal: false }],
  };
  assert.equal(bindAddress(undefined, ifaces), "127.0.0.1");
  assert.equal(bindAddress("container", ifaces), "172.20.0.2");
  assert.throws(() => bindAddress("container", { lo: ifaces.lo, tailscale0: ifaces.tailscale0 }), /no container network address/);
});
