// @ts-check
// funnel: the /s/ share path on Tailscale Funnel, against a fake tailscale that keeps a serve
// config the way the real one does, and a fake module context. No real binary, no network.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFunnel, parseShare, consentUrl, onArgs, offArgs } from "./funnel.js";

const HOST = "box.tail0000.ts.net";
const HP = `${HOST}:8443`;
const CONSENT = "https://login.tailscale.com/f/funnel?node=n123";

/** A fake tailscale: `status --json`, `funnel status --json`, and funnel on/off by path. */
function fakeTailscale(o = {}) {
  const w = { backend: "Running", consent: false, dns: `${HOST}.`, ...o };
  /** @type {any} */
  const cfg = { TCP: { "8443": { HTTPS: true } }, Web: { [HP]: { Handlers: {} } }, AllowFunnel: {} };
  /** @type {string[][]} */ const calls = [];
  const exec = async (/** @type {string[]} */ args) => {
    calls.push(args);
    if (args[0] === "status") return { code: 0, out: JSON.stringify({ BackendState: w.backend, Self: { DNSName: w.dns } }), err: "" };
    if (args[0] === "funnel" && args[1] === "status") return { code: 0, out: JSON.stringify(cfg), err: "" };
    if (args[0] === "funnel") {
      const path = (args.find(a => a.startsWith("--set-path=")) || "").slice("--set-path=".length);
      // A funnel with no path, or reset, would wipe everything: the fake does it so a test notices.
      if (args.includes("reset") || (args.includes("off") && !path)) { cfg.Web[HP].Handlers = {}; return { code: 0, out: "", err: "" }; }
      if (args.includes("off")) { delete cfg.Web[HP].Handlers[path]; return { code: 0, out: "", err: "" }; }
      if (w.consent) return { code: 1, out: "", err: `Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n\t${CONSENT}\n` };
      cfg.Web[HP].Handlers[path] = { Proxy: args[args.length - 1] };
      cfg.AllowFunnel[HP] = true;
      return { code: 0, out: "Available on the internet:\n", err: "" };
    }
    return { code: 1, out: "", err: "unexpected" };
  };
  return { w, cfg, calls, exec, changes: () => calls.filter(a => a[0] === "funnel" && a[1] !== "status") };
}

/** A fake module context: tools, events in and out, and a call log for artifacts.public.base. */
function fakeCtx(network = {}) {
  /** @type {Map<string, Function[]>} */ const on = new Map();
  /** @type {any[]} */ const emitted = [], told = [];
  const tools = new Map();
  /** What artifacts.public.status answers: its own share server's port. */
  const share = { available: true, on: true, port: 7311 };
  const ctx = {
    config: { network }, log: () => {},
    events: {
      on: (/** @type {string} */ p, /** @type {Function} */ fn) => { on.set(p, [...(on.get(p) || []), fn]); return () => on.set(p, (on.get(p) || []).filter(f => f !== fn)); },
      emit: (/** @type {string} */ type, /** @type {any} */ payload) => { emitted.push({ type, payload }); },
    },
    tool: (/** @type {string} */ name, /** @type {any} */ def) => tools.set(name, def),
    call: async (/** @type {string} */ tool, /** @type {any} */ input) => { if (tool === "artifacts.public.status") return { ...share }; told.push({ tool, input }); return { ok: true }; },
  };
  const hear = (/** @type {any} */ payload, source = "artifacts") => { for (const f of on.get("artifact-links.changed") || []) f({ type: "artifact-links.changed", source, payload }); };
  return { ctx, emitted, told, tools, hear, share };
}

const HOOK = { Proxy: "http://127.0.0.1:7310/hooks/orders" };

test("funnel: on runs funnel for /s/ on 8443 only, off turns exactly that path off, and hooks are untouched", async () => {
  const ts = fakeTailscale();
  ts.cfg.Web[HP].Handlers["/hooks/orders"] = HOOK;
  const m = fakeCtx();
  const f = await startFunnel(m.ctx, { exec: ts.exec });
  m.hear({ on: true, port: 7311, path: "/s/" });
  await f.idle();
  assert.deepEqual(ts.changes(), [["funnel", "--bg", "--https=8443", "--set-path=/s/", "http://127.0.0.1:7311/s/"]]);
  assert.deepEqual(ts.cfg.Web[HP].Handlers["/s/"], { Proxy: "http://127.0.0.1:7311/s/" });
  assert.deepEqual(ts.cfg.Web[HP].Handlers["/hooks/orders"], HOOK);
  assert.equal(f.state().state, "on");

  m.hear({ on: false, port: 7311, path: "/s/" });
  await f.idle();
  assert.deepEqual(ts.changes()[1], ["funnel", "--https=8443", "--set-path=/s/", "off"]);
  assert.equal(ts.cfg.Web[HP].Handlers["/s/"], undefined);
  assert.deepEqual(ts.cfg.Web[HP].Handlers["/hooks/orders"], HOOK, "the hooks path is still served");
  assert.equal(f.state().state, "off");
  // Nothing it ever ran is a reset or a path-less off.
  for (const a of ts.changes()) { assert.ok(a.some(x => x === "--set-path=/s/")); assert.ok(!a.includes("reset")); }
  await f.stop();
});

test("funnel: the base URL is the node's DNS name on 8443, given to artifacts.public.base, and null when off", async () => {
  const ts = fakeTailscale();
  const m = fakeCtx();
  const f = await startFunnel(m.ctx, { exec: ts.exec });
  m.hear({ on: true, port: 7311, path: "/s/" });
  await f.idle();
  assert.equal(f.state().base, `https://${HOST}:8443`, "no trailing dot");
  assert.deepEqual(m.told, [{ tool: "artifacts.public.base", input: { base: `https://${HOST}:8443` } }]);
  m.hear({ on: false, port: 7311, path: "/s/" });
  await f.idle();
  assert.deepEqual(m.told[1], { tool: "artifacts.public.base", input: { base: null } });
  assert.equal(f.state().base, null);
  await f.stop();
});

test("funnel: running it again changes nothing, and off when nothing is served runs nothing", async () => {
  const ts = fakeTailscale();
  const m = fakeCtx();
  const f = await startFunnel(m.ctx, { exec: ts.exec });
  m.hear({ on: false, port: 7311, path: "/s/" });
  await f.idle();
  assert.equal(ts.changes().length, 0, "off with nothing served is no command");
  m.hear({ on: true, port: 7311, path: "/s/" });
  await f.idle();
  m.hear({ on: true, port: 7311, path: "/s/" });
  await f.idle();
  assert.equal(ts.changes().length, 1, "the second on found it already served");
  // A new port is a change, and replaces the target.
  m.share.port = 7400;
  m.hear({ on: true, port: 7400, path: "/s/" });
  await f.idle();
  assert.equal(ts.changes().length, 2);
  assert.equal(ts.cfg.Web[HP].Handlers["/s/"].Proxy, "http://127.0.0.1:7400/s/");
  await f.stop();
});

test("funnel: another module's event changes nothing, and the port is artifacts', not the event's", async () => {
  const ts = fakeTailscale();
  const m = fakeCtx();
  const f = await startFunnel(m.ctx, { exec: ts.exec });
  m.hear({ on: true, port: 5432, path: "/s/" }, "sneaky");
  await f.idle();
  assert.deepEqual(ts.calls, [], "an event from another module is ignored");
  m.hear({ on: true, port: 5432, path: "/s/" });
  await f.idle();
  assert.deepEqual(ts.changes(), [["funnel", "--bg", "--https=8443", "--set-path=/s/", "http://127.0.0.1:7311/s/"]], "the event names 5432; the share server's own port is used");
  m.share.available = false;
  m.hear({ on: true, port: 7311, path: "/s/" });
  const g = fakeCtx(); g.share.available = false;
  const ts2 = fakeTailscale();
  const f2 = await startFunnel(g.ctx, { exec: ts2.exec });
  g.hear({ on: true, path: "/s/" });
  await f2.idle();
  assert.equal(f2.state().state, "error");
  assert.deepEqual(ts2.changes(), [], "no share server, nothing published");
  await f.stop(); await f2.stop();
});

test("funnel: an event for another path is ignored", async () => {
  const ts = fakeTailscale();
  const m = fakeCtx();
  const f = await startFunnel(m.ctx, { exec: ts.exec });
  m.hear({ on: true, port: 7311, path: "/hooks/" });
  m.hear({ on: "yes" });
  await f.idle();
  assert.deepEqual(ts.calls, []);
  await f.stop();
});

test("funnel: consent needed shows the link as state and an event, and grants it on the next read", async () => {
  const ts = fakeTailscale({ consent: true });
  const clock = { t: 1000 };
  const m = fakeCtx();
  const f = await startFunnel(m.ctx, { exec: ts.exec, now: () => clock.t });
  m.hear({ on: true, port: 7311, path: "/s/" });
  await f.idle();
  const needs = f.state();
  assert.equal(needs.state, "needs-consent");
  assert.equal(needs.consentUrl, CONSENT);
  assert.equal(consentUrl("Funnel is not enabled. To enable, visit https://evil.example/login"), null, "only a tailscale.com link is shown");
  assert.equal(needs.base, null);
  assert.deepEqual(m.told.at(-1), { tool: "artifacts.public.base", input: { base: null } }, "no public base until it works");
  const ev = m.emitted.filter(e => e.type === "funnel.changed");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.state, "needs-consent");
  assert.equal(ev[0].payload.consentUrl, CONSENT);

  const status = m.tools.get("network.funnel.status");
  // A read straight away does not hammer Tailscale.
  const before = ts.calls.length;
  assert.equal((await status.run({}, { caller: "deck" })).state, "needs-consent");
  assert.equal(ts.calls.length, before);
  // The person followed the link. The next read after the wait runs it again.
  ts.w.consent = false;
  clock.t += 6000;
  const after = await status.run({}, { caller: "deck" });
  assert.equal(after.state, "on");
  assert.equal(after.consentUrl, null);
  assert.equal(after.base, `https://${HOST}:8443`);
  assert.equal(m.emitted.filter(e => e.type === "funnel.changed").at(-1).payload.state, "on");
  await f.stop();
});

test("funnel: network.funnel.status is the owner's, and says nothing while it is off", async () => {
  const ts = fakeTailscale();
  const m = fakeCtx();
  const f = await startFunnel(m.ctx, { exec: ts.exec, guard: c => { if (String(c).startsWith("tailnet-guest:")) throw new Error("denied"); } });
  const status = m.tools.get("network.funnel.status");
  assert.equal((await status.run({}, { caller: "cli" })).state, "off");
  await assert.rejects(status.run({}, { caller: "tailnet-guest:sam@harlow.example" }), /denied/);
  assert.equal(ts.calls.length, 0, "never turned on: Tailscale is not even asked");
  await f.stop();
});

test("funnel: at start it reconciles from the persisted toggle, on or off", async () => {
  const ts = fakeTailscale();
  const on = fakeCtx({ funnel: { share: { on: true, port: 7311 } } });
  const f1 = await startFunnel(on.ctx, { exec: ts.exec });
  await f1.idle();
  assert.equal(ts.cfg.Web[HP].Handlers["/s/"].Proxy, "http://127.0.0.1:7311/s/");
  assert.equal(f1.state().state, "on");
  await f1.stop();

  // Now the toggle is off but Funnel still serves it (a crash between the two): start turns it off.
  const off = fakeCtx({ funnel: { share: { on: false, port: 7311 } } });
  const f2 = await startFunnel(off.ctx, { exec: ts.exec });
  await f2.idle();
  assert.equal(ts.cfg.Web[HP].Handlers["/s/"], undefined);
  await f2.stop();

  // Never set: Funnel is left alone.
  const none = fakeTailscale();
  const f3 = await startFunnel(fakeCtx().ctx, { exec: none.exec });
  await f3.idle();
  assert.deepEqual(none.calls, []);
  await f3.stop();
});

test("funnel: Tailscale missing or stopped is an error state with a reason, not a throw", async () => {
  const stopped = fakeTailscale({ backend: "Stopped" });
  const m = fakeCtx();
  const f = await startFunnel(m.ctx, { exec: stopped.exec });
  m.hear({ on: true, port: 7311, path: "/s/" });
  await f.idle();
  assert.equal(f.state().state, "error");
  assert.match(String(f.state().why), /Stopped/);
  assert.equal(stopped.changes().length, 0);
  await f.stop();

  const gone = fakeCtx();
  const g = await startFunnel(gone.ctx, { exec: async () => ({ code: 127, out: "", err: "" }) });
  gone.hear({ on: true, port: 7311, path: "/s/" });
  await g.idle();
  assert.match(String(g.state().why), /not installed/);
  await g.stop();
});

test("funnel: the pure parts, share parsing, the consent link and the exact commands", () => {
  assert.deepEqual(parseShare({}), { served: false, target: null, funnel: false });
  assert.deepEqual(parseShare({ Web: { [HP]: { Handlers: { "/s/": { Proxy: "http://127.0.0.1:7311/s/" }, "/hooks/a": HOOK } } }, AllowFunnel: { [HP]: true } }),
    { served: true, target: "http://127.0.0.1:7311/s/", funnel: true });
  assert.equal(parseShare({ Web: { [HP]: { Handlers: { "/hooks/a": HOOK } } }, AllowFunnel: { [HP]: true } }).served, false);
  assert.equal(parseShare({ Web: { [`${HOST}:443`]: { Handlers: { "/s/": { Proxy: "x" } } } } }).served, false, "only 8443");
  assert.equal(consentUrl(`Funnel is not enabled on your tailnet.\nTo enable, visit:\n\t${CONSENT}\n`), CONSENT);
  assert.equal(consentUrl("Serve is not enabled on your tailnet. To enable, visit: https://login.tailscale.com/f/serve?node=n1"), "https://login.tailscale.com/f/serve?node=n1");
  assert.equal(consentUrl("error: something at https://example.com"), null, "a link alone is not consent");
  assert.deepEqual(onArgs(7311), ["funnel", "--bg", "--https=8443", "--set-path=/s/", "http://127.0.0.1:7311/s/"]);
  assert.deepEqual(offArgs(), ["funnel", "--https=8443", "--set-path=/s/", "off"]);
});
