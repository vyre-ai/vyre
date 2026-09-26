// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, sshLine } from "./up.js";

test("up: flags with and without values", () => {
  assert.deepEqual(parse(["--system", "--user", "alex", "--dry-run"]), { flags: { system: true, user: "alex", "dry-run": true }, rest: [] });
  assert.deepEqual(parse(["--user=alex", "file"]), { flags: { user: "alex" }, rest: ["file"] });
});

test("up: over SSH, the tunnel line points at the address the person connected to", () => {
  assert.equal(sshLine(7300, "alex", { SSH_CONNECTION: "203.0.113.9 51234 198.51.100.4 22" }), "ssh -N -L 7300:127.0.0.1:7300 alex@198.51.100.4");
  assert.equal(sshLine(7300, "alex", { SSH_CONNECTION: "2001:db8::9 51234 2001:db8::4 22" }), "ssh -N -L 7300:127.0.0.1:7300 alex@[2001:db8::4]");
  assert.equal(sshLine(7300, "vyre", { SSH_CONNECTION: "203.0.113.9 51234 198.51.100.4 22", VYRE_HOST_USER: "alex" }), "ssh -N -L 7300:127.0.0.1:7300 alex@198.51.100.4", "the host account, not the container's");
  assert.equal(sshLine(7300, "alex", {}), null, "not over SSH: no tunnel needed");
});

// The Mac side of `vyre up` (ADR 0008): every piece that would touch the world is a fake. vyred is
// never started (bring), tools answer from a table (call), the tailnet comes from a fake
// `tailscale` binary, and probe() answers from a set of addresses instead of fetching over TLS.

import fs from "node:fs";
import path from "node:path";
import { up } from "./up.js";
import * as tailnet from "../tailnet.js";
import * as config from "../../config/index.js";
import { tempHome } from "../../../test/helpers.js";

const ME = 1, OTHER = 2;
const peer = (name, user = ME, extra = {}) => ({ DNSName: `${name}.example-tail.ts.net.`, HostName: name, TailscaleIPs: ["100.64.0.9"], Online: true, UserID: user, ...extra });

/** A fake `tailscale` that prints this status, and a VYRE_HOME, both removed after the test. */
function world(t, status) {
  const home = tempHome(t);
  const bin = path.join(home, "tailscale");
  fs.writeFileSync(bin, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(status)}\nJSON\n`, { mode: 0o755 });
  const prev = process.env.VYRE_TAILSCALE_BIN;
  process.env.VYRE_TAILSCALE_BIN = bin;
  t.after(() => { if (prev === undefined) delete process.env.VYRE_TAILSCALE_BIN; else process.env.VYRE_TAILSCALE_BIN = prev; });
  config.save({ role: "local" });
  return home;
}

const running = peers => ({
  BackendState: "Running", Self: { DNSName: "alex-mac.example-tail.ts.net.", HostName: "alex-mac", UserID: ME, TailscaleIPs: ["100.64.0.2"] },
  User: { [ME]: { LoginName: "alex@example.com" } }, Peer: Object.fromEntries(peers.map((p, i) => [`k${i}`, p])),
});

/** Deps with fakes. `answering` is the set of addresses whose health answers. */
function fakes(t, { answering = [], tools = {}, answers = [], tty = true } = {}) {
  const lines = [];
  t.mock.method(console, "log", (...a) => { lines.push(a.join(" ")); });
  const calls = [], added = [], opened = [];
  const deps = {
    bring: async () => ({ ok: true, note: null }),
    call: async (tool, input) => { calls.push([tool, input]); return tools[tool] ? tools[tool](input) : { error: { code: "no_such_tool", message: tool } }; },
    tailnet: { status: tailnet.status, boxes: tailnet.boxes, probe: async a => answering.includes(a.replace(/\/$/, "")) ? { version: "0.1.0", role: "box" } : null },
    io: { tty, ask: async q => { lines.push("? " + q); return answers.shift() ?? ""; } },
    addBox: async (target, opts) => { added.push(target); return 0; },
    openUrl: url => opened.push(url),
    platform: "darwin",
  };
  return { deps, lines, calls, added, opened, text: () => lines.join("\n") };
}

const BOX = "https://vyre.example-tail.ts.net";

test("up --json on a Mac with no box and none found: one object, box null, not ready", async t => {
  world(t, running([]));
  const f = fakes(t, { tty: false });
  assert.equal(await up(["--json"], f.deps), 0);
  assert.equal(f.lines.length, 1, "exactly one line: the object");
  const o = JSON.parse(f.lines[0]);
  assert.deepEqual(Object.keys(o), ["role", "version", "url", "port", "ssh", "address", "box", "ready"]);
  assert.equal(o.role, "local");
  assert.equal(o.box, null);
  assert.equal(o.ready, false);
  assert.doesNotMatch(f.lines[0], /\x1b/, "no colour codes");
});

test("up on a Mac: exactly one box answers on the tailnet, so it is saved and the ending prints", async t => {
  world(t, running([peer("vyre"), peer("vyre-2", OTHER), peer("vyre-3", ME, { Online: false }), peer("printer")]));
  const f = fakes(t, { answering: [BOX] });
  assert.equal(await up([], f.deps), 0);
  assert.equal(config.load().network.box, BOX);
  assert.match(f.text(), /Vyre is ready\./);
  assert.match(f.text(), /your box\s+https:\/\/vyre\.example-tail\.ts\.net/);
  assert.equal(f.calls[0][0], "link.status", "pairing is looked at; no_such_tool is skipped quietly");
  assert.doesNotMatch(f.text(), /link:/);
});

test("up --json on a Mac with its box answering: ready, and the box named", async t => {
  world(t, running([peer("vyre")]));
  const f = fakes(t, { answering: [BOX] });
  assert.equal(await up(["--json"], f.deps), 0);
  const o = JSON.parse(f.lines[0]);
  assert.equal(f.lines.length, 1);
  assert.equal(o.box, BOX);
  assert.equal(o.ready, true);
  assert.equal(o.url, null);
});

test("up on a Mac: two boxes answer; with a terminal it asks which, without one it lists them and exits 1", async t => {
  world(t, running([peer("vyre"), peer("vyre-2")]));
  const two = [BOX, "https://vyre-2.example-tail.ts.net"];
  const quiet = fakes(t, { answering: two, tty: false });
  assert.equal(await up([], quiet.deps), 1);
  assert.match(quiet.text(), /1\s+https:\/\/vyre\.example/);
  assert.match(quiet.text(), /2\s+https:\/\/vyre-2\.example/);
  assert.equal(config.load().network.box, undefined, "nothing saved without a choice");
  t.mock.restoreAll();

  const asked = fakes(t, { answering: two, answers: ["2"] });
  assert.equal(await up([], asked.deps), 0);
  assert.equal(config.load().network.box, two[1]);
  t.mock.restoreAll();

  config.save({ network: { box: null } });
  const j = fakes(t, { answering: two });
  assert.equal(await up(["--json"], j.deps), 1);
  assert.equal(JSON.parse(j.lines[0]).error.code, "several_boxes");
});

test("up on a Mac with no terminal and no box: the three commands, exit 0", async t => {
  world(t, running([]));
  const f = fakes(t, { tty: false });
  assert.equal(await up([], f.deps), 0);
  for (const c of ["vyre box add user@host", "vyre up --box", "vyre up --connect <address>"]) assert.ok(f.text().includes(c), c);
  assert.doesNotMatch(f.text(), /\? /, "nothing asked");
});

test("up on a Mac: Tailscale signed out is said before the question; choosing 1 hands the server to box add", async t => {
  world(t, { BackendState: "NeedsLogin", Self: { UserID: ME } });
  const f = fakes(t, { answers: ["1", "alex@203.0.113.7"] });
  assert.equal(await up([], f.deps), 0);
  const text = f.text();
  assert.ok(text.indexOf("signed out") >= 0 && text.indexOf("signed out") < text.indexOf("Where should Vyre run?"));
  assert.match(text, /on a server I can SSH to/);
  assert.deepEqual(f.added, ["alex@203.0.113.7"]);
});

test("up on a Mac: choosing 3 saves the address given, as --connect does", async t => {
  world(t, running([]));
  const f = fakes(t, { answering: [BOX], answers: ["3", "vyre.example-tail.ts.net/"] });
  assert.equal(await up([], f.deps), 0);
  assert.equal(config.load().network.box, BOX);
  assert.match(f.text(), /Vyre is ready\./);
});

test("up on a Mac: a known box that does not answer says why and exits 1", async t => {
  world(t, { BackendState: "Stopped", Self: { UserID: ME } });
  config.save({ network: { box: BOX } });
  const f = fakes(t);
  assert.equal(await up([], f.deps), 1);
  assert.match(f.text(), /your box https:\/\/vyre\.example-tail\.ts\.net did not answer from here/);
  assert.match(f.text(), /this Mac is not on the tailnet/);
  t.mock.restoreAll();

  const j = fakes(t);
  assert.equal(await up(["--json"], j.deps), 1);
  assert.equal(JSON.parse(j.lines[0]).error.code, "box_unreachable");
});

test("up on a Mac: an unpaired box is paired through link.pair", async t => {
  world(t, running([]));
  config.save({ network: { box: BOX } });
  const f = fakes(t, { answering: [BOX], tools: { "link.status": () => ({ data: { paired: false } }), "link.pair": () => ({ data: { paired: true } }) } });
  assert.equal(await up([], f.deps), 0);
  assert.deepEqual(f.calls.map(c => c[0]), ["link.status", "link.pair"]);
  assert.match(f.text(), /paired with your box/);
});

test("up --box on a Mac: the one-time link is printed and opened; --json gives url and port", async t => {
  world(t, running([]));
  const link = { data: { url: "http://127.0.0.1:7300/onboard#t=abc", port: 7300, user: "alex", address: null } };
  const f = fakes(t, { tools: { "onboard.link": () => link } });
  const prev = process.env.SSH_CONNECTION; delete process.env.SSH_CONNECTION;
  t.after(() => { if (prev !== undefined) process.env.SSH_CONNECTION = prev; });
  assert.equal(await up(["--box"], f.deps), 0);
  assert.match(f.text(), /127\.0\.0\.1:7300\/onboard/);
  assert.deepEqual(f.opened, [link.data.url]);
  t.mock.restoreAll();

  const j = fakes(t, { tools: { "onboard.link": () => link } });
  assert.equal(await up(["--box", "--json"], j.deps), 0);
  assert.deepEqual(JSON.parse(j.lines[0]), { role: "box", version: JSON.parse(j.lines[0]).version, url: link.data.url, port: 7300, ssh: null, address: null, box: null, ready: false });
  assert.deepEqual(j.opened, [], "a caller parsing JSON opens what it wants");
});

test("up on a box after onboarding: the ending block, the same as on the Mac", async t => {
  world(t, running([]));
  config.save({ role: "box", onboard: { assistant: "Juno" } });
  const done = { data: { url: null, port: null, user: "alex", address: BOX } };
  const f = fakes(t, { answering: [BOX], tools: { "onboard.link": () => done } });
  f.deps.platform = "linux";
  assert.equal(await up([], f.deps), 0);
  assert.match(f.text(), /Vyre is ready\./);
  assert.match(f.text(), /your assistant\s+Juno/);
  assert.doesNotMatch(f.text(), /your address:/);
  t.mock.restoreAll();

  const j = fakes(t, { answering: [BOX], tools: { "onboard.link": () => done } });
  assert.equal(await up(["--json"], j.deps), 0);
  const o = JSON.parse(j.lines[0]);
  assert.equal(o.address, BOX);
  assert.equal(o.ready, true);
});
