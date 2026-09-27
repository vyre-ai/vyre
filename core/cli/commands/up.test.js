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
import { up, mac } from "./up.js";
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
function fakes(t, { answering = [], found = [], tools = {}, answers = [], tty = true } = {}) {
  const lines = [];
  t.mock.method(console, "log", (...a) => { lines.push(a.join(" ")); });
  const calls = [], added = [], opened = [];
  const deps = {
    bring: async () => ({ ok: true, note: null }),
    call: async (tool, input) => {
      calls.push([tool, input]);
      if (tools[tool]) return tools[tool](input);
      if (tool === "link.find") return { data: { boxes: found.map(address => ({ address, node: "" })), paired: null } };
      return { error: { code: "no_such_tool", message: tool } };
    },
    health: async a => answering.includes(a.replace(/\/$/, "")) ? { version: "0.1.0", role: "box" } : null,
    openCapsule: async () => { calls.push(["capsule"]); return true; },
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
  const f = fakes(t, { answering: [BOX], found: [BOX] });
  assert.equal(await up([], f.deps), 0);
  assert.equal(config.load().network.box, BOX);
  assert.match(f.text(), /Vyre is ready\./);
  assert.match(f.text(), /your box\s+https:\/\/vyre\.example-tail\.ts\.net/);
  assert.deepEqual(f.calls.map(c => c[0]), ["link.find", "link.status", "capsule"], "pairing is looked at; no_such_tool is skipped quietly");
  assert.doesNotMatch(f.text(), /link:/);
});

test("up --json on a Mac with its box answering: ready, and the box named", async t => {
  world(t, running([peer("vyre")]));
  const f = fakes(t, { answering: [BOX], found: [BOX] });
  assert.equal(await up(["--json"], f.deps), 0);
  const o = JSON.parse(f.lines[0]);
  assert.equal(f.lines.length, 1);
  assert.equal(o.box, BOX);
  assert.equal(o.ready, true);
  assert.equal(o.url, null);
});

test("up on a Mac: two boxes answer; with a terminal it asks which, without one it lists them", async t => {
  world(t, running([peer("vyre"), peer("vyre-2")]));
  const two = [BOX, "https://vyre-2.example-tail.ts.net"];
  const quiet = fakes(t, { answering: two, found: two, tty: false });
  assert.equal(await up([], quiet.deps), 0);
  assert.match(quiet.text(), /1\s+https:\/\/vyre\.example/);
  assert.match(quiet.text(), /2\s+https:\/\/vyre-2\.example/);
  assert.equal(config.load().network.box, undefined, "nothing saved without a choice");
  t.mock.restoreAll();

  const asked = fakes(t, { answering: two, found: two, answers: ["2"] });
  assert.equal(await up([], asked.deps), 0);
  assert.equal(config.load().network.box, two[1]);
  t.mock.restoreAll();

  config.save({ network: { box: null } });
  const j = fakes(t, { answering: two, found: two });
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
  assert.match(text, /On a server I can SSH to/);
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

test("up on a Mac: an unpaired box starts pairing through link.pair and shows the code", async t => {
  world(t, running([]));
  config.save({ network: { box: BOX } });
  const f = fakes(t, { answering: [BOX], tools: { "link.status": () => ({ data: { linked: false, pending: null } }), "link.pair": () => ({ data: { code: "123-456" } }) } });
  assert.equal(await up([], f.deps), 0);
  assert.deepEqual(f.calls.map(c => c[0]), ["link.status", "link.pair", "capsule"]);
  assert.match(f.text(), /Approve this Mac on your phone at \S+[\s\S]*Code: 123-456/);
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
  const serving = () => ({ data: { phase: "serving" } });
  const f = fakes(t, { tools: { "onboard.link": () => done, "names.status": serving } });
  f.deps.platform = "linux";
  assert.equal(await up([], f.deps), 0);
  assert.match(f.text(), /Vyre is ready\./);
  assert.match(f.text(), /your assistant\s+Juno/);
  assert.doesNotMatch(f.text(), /your address:/);
  t.mock.restoreAll();

  const j = fakes(t, { tools: { "onboard.link": () => done, "names.status": serving } });
  assert.equal(await up(["--json"], j.deps), 0);
  const o = JSON.parse(j.lines[0]);
  assert.equal(o.address, BOX);
  assert.equal(o.ready, true);
});

/** mac() with a fake box and link; returns what it called and printed. */
async function runMac(box, { healthy = true, status = { linked: false, pending: null }, pair = { code: "123-456" }, found = [], capsule = true, platform = "darwin", opened = true, io = undefined } = {}) {
  const calls = [], lines = [], saved = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  let code;
  try {
    code = await mac(box, { capsule }, {
      health: async () => healthy,
      tool: async (name, input) => {
        calls.push([name, input]);
        return name === "link.status" ? { data: status } : name === "link.find" ? { data: { boxes: found, paired: null } } : { data: pair };
      },
      save: c => saved.push(c),
      platform,
      openCapsule: async () => { calls.push(["capsule"]); return opened; },
      statusline: async () => { calls.push(["statusline"]); },
      io: io || { tty: false, ask: async () => "" },
    });
  } finally { console.log = log; }
  return { code, calls, saved, text: lines.join("\n") };
}

test("up on a Mac: no box given and none found says how to point at one, and does nothing else", async () => {
  const r = await runMac(undefined);
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls.map(c => c[0]), ["link.find"]);
  assert.deepEqual(r.saved, []);
  assert.match(r.text, /vyre up --connect/);
});

test("up on a Mac: the one box found on the tailnet is saved and paired with", async () => {
  const r = await runMac(undefined, { found: [{ address: "https://alex.vyre.run", node: "box" }] });
  assert.deepEqual(r.saved, [{ network: { box: "https://alex.vyre.run" } }]);
  assert.deepEqual(r.calls.map(c => c[0]), ["link.find", "link.status", "link.pair", "capsule"]);
});

test("up on a Mac: two boxes found are listed, and neither is picked", async () => {
  const r = await runMac(undefined, { found: [{ address: "https://a.vyre.run" }, { address: "https://b.vyre.run" }] });
  assert.deepEqual(r.saved, []);
  assert.match(r.text, /a\.vyre\.run[\s\S]*b\.vyre\.run/);
  assert.deepEqual(r.calls.map(c => c[0]), ["link.find"]);
});

test("up on a Mac: an unreachable box stops before pairing or the Capsule", async () => {
  const r = await runMac("https://alex.vyre.run", { healthy: false });
  assert.equal(r.code, 1);
  assert.deepEqual(r.calls, []);
});

test("up on a Mac: not paired starts pairing, prints the code to approve, then opens the Capsule", async () => {
  const r = await runMac("https://alex.vyre.run");
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls.map(c => c[0]), ["link.status", "link.pair", "capsule"]);
  assert.deepEqual(r.calls[1][1], { box: "https://alex.vyre.run" });
  assert.match(r.text, /Approve this Mac on your phone at \S+[\s\S]*Code: 123-456/);
});

test("up on a Mac: on a terminal the status line is offered before the Capsule; without one it is not", async () => {
  const tty = await runMac("https://alex.vyre.run", { io: { tty: true, ask: async () => "" } });
  assert.deepEqual(tty.calls.map(c => c[0]), ["link.status", "link.pair", "statusline", "capsule"]);
  const piped = await runMac("https://alex.vyre.run", { io: { tty: false, ask: async () => "" } });
  assert.ok(!piped.calls.some(c => c[0] === "statusline"));
});

test("up on a Mac: a pairing already waiting shows its code instead of starting another", async () => {
  const r = await runMac("https://alex.vyre.run", { status: { linked: false, pending: { code: "654-321" } } });
  assert.deepEqual(r.calls.map(c => c[0]), ["link.status", "capsule"]);
  assert.match(r.text, /Approve this Mac on your phone at \S+[\s\S]*Code: 654-321/);
});

test("up on a Mac: already linked goes straight to the Capsule; --no-capsule skips it", async () => {
  const linked = { linked: true };
  assert.deepEqual((await runMac("https://alex.vyre.run", { status: linked })).calls.map(c => c[0]), ["link.status", "capsule"]);
  assert.deepEqual((await runMac("https://alex.vyre.run", { status: linked, capsule: false })).calls.map(c => c[0]), ["link.status"]);
});

test("up on a Mac: with no Capsule installed it points at the download", async () => {
  const r = await runMac("https://alex.vyre.run", { status: { linked: true }, opened: false });
  assert.equal(r.code, 0);
  assert.match(r.text, /vyre capsule install/);
});

test("up --connect with no address is refused, and nothing is saved", async t => {
  world(t, running([]));
  for (const args of [["--connect"], ["--connect", "--json"], ["--connect="]]) {
    const f = fakes(t);
    assert.equal(await up(args, f.deps), 1, args.join(" "));
    assert.match(f.text(), /--connect needs your box's address/);
    t.mock.restoreAll();
  }
  const j = fakes(t);
  assert.equal(await up(["--json", "--connect"], j.deps), 1);
  assert.equal(j.lines.length, 1);
  assert.equal(JSON.parse(j.lines[0]).error.code, "no_address");
  assert.equal(config.load().network.box, undefined);
});

test("up --json --system is refused with one JSON error, not the system plan", async t => {
  world(t, running([]));
  const f = fakes(t);
  assert.equal(await up(["--system", "--json", "--dry-run", "--user", "alex"], f.deps), 1);
  assert.equal(f.lines.length, 1);
  assert.equal(JSON.parse(f.lines[0]).error.code, "bad_input");
});

test("up --json: a throw anywhere is still exactly one error object and exit 1", async t => {
  world(t, running([]));
  for (const breakIt of [
    d => { d.bring = async () => { throw new Error("bring broke"); }; },
    d => { d.call = async () => { throw new Error("tool broke"); }; },
  ]) {
    const f = fakes(t);
    breakIt(f.deps);
    assert.equal(await up(["--json"], f.deps), 1);
    assert.equal(f.lines.length, 1);
    const o = JSON.parse(f.lines[0]);
    assert.equal(o.error.code, "failed");
    assert.match(o.error.message, /broke/);
    t.mock.restoreAll();
  }
  // Without --json a throw still surfaces as a throw, as before.
  const f = fakes(t);
  f.deps.bring = async () => { throw new Error("bring broke"); };
  await assert.rejects(up([], f.deps), /bring broke/);
});

test("up --keep-link on a box (vyre update): reports the open link, mints none, opens nothing", async t => {
  world(t, running([]));
  config.save({ role: "box" });
  const open = { data: { url: null, pending: true, expires: Date.now() + 42 * 60_000, port: 7300, user: "alex", address: null, passkeyUrl: null } };
  const f = fakes(t, { tools: { "onboard.link": () => open } });
  f.deps.platform = "linux";
  assert.equal(await up(["--keep-link"], f.deps), 0);
  assert.deepEqual(f.calls.find(c => c[0] === "onboard.link")[1], { mint: false });
  assert.match(f.text(), /set up is not finished; the link you have still works \(42 min left\)/);
  assert.match(f.text(), /vyre up prints a new link and voids that one/);
  assert.deepEqual(f.opened, []);
  t.mock.restoreAll();

  const none = { data: { ...open.data, pending: false, expires: null, port: null } };
  const j = fakes(t, { tools: { "onboard.link": () => none } });
  assert.equal(await up(["--keep-link", "--json"], j.deps), 0);
  const o = JSON.parse(j.lines[0]);
  assert.deepEqual([o.url, o.pending, o.expires], [null, false, null]);
});

test("up on a Mac, the very first time: the welcome, the three choices, and choice 3 pairs and says where to approve", async t => {
  const home = world(t, running([]));
  fs.rmSync(path.join(home, "config.json"), { force: true });
  const f = fakes(t, { answering: [BOX], answers: ["3", "vyre.example-tail.ts.net"], tools: {
    "link.status": () => ({ data: { linked: false, pending: null } }),
    "link.pair": () => ({ data: { code: "123-456" } }),
  } });
  // --local stands in for a Mac's default role, so this runs the same on Linux.
  assert.equal(await up(["--local"], f.deps), 0);
  const text = f.text();
  assert.match(text, /v·  Vyre is installed · 0\.0\.1/);
  assert.match(text, /Vyre runs Claude Code on a machine you own/);
  assert.ok(text.indexOf("Vyre is installed") < text.indexOf("Where should Vyre run?"), "the welcome comes first");
  assert.match(text, /1  On a server I can SSH to[\s\S]*2  On this Mac[\s\S]*3  I already set up a box/);
  assert.match(text, /Asking https:\/\/vyre\.example-tail\.ts\.net to pair with this Mac/);
  assert.match(text, /Approve this Mac on your phone at https:\/\/vyre\.example-tail\.ts\.net[\s\S]*Code: 123-456/);
  assert.doesNotMatch(text, /vyred running ·/, "a first run gets the welcome, not a status line");
  assert.deepEqual(f.opened, [], "nothing is opened in a browser");
});
