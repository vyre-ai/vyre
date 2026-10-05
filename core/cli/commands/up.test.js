// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse, sshLine, envCandidates } from "./up.js";
import { SCRATCH } from "../../../test/scratch.mjs";

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

test("up: envCandidates counts secret-looking .env values, never the trivial or already-vault'd ones", (t) => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-up-env-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(envCandidates(dir), 0, "no .env at all");
  fs.writeFileSync(path.join(dir, ".env"), [
    "PORT=3000", "NODE_ENV=production", "DEBUG=true", "COUNT=42",
    `OPENAI_API_KEY=${["sk", "proj", "a1b2c3d4e5f6g7h8"].join("-")}`,
    `export STRIPE_KEY="${["sk", "live", "a1b2c3d4e5f6g7h8"].join("_")}"`,
    "ALREADY_IN=vault://acme-openai-key/value",
    "",
    "# a comment=not a variable",
  ].join("\n"));
  assert.equal(envCandidates(dir), 2, "two secret-looking values; the rest are trivial, referenced or not a variable");
  fs.writeFileSync(path.join(dir, ".env.local"), "ANOTHER_KEY=totally-made-up-fixture-value\n");
  assert.equal(envCandidates(dir), 3, "checks .env.local too");
});

// The Mac side of `vyre up` (ADR 0008): every piece that would touch the world is a fake. vyred is
// never started (bring), tools answer from a table (call), and the health probe answers from a set of addresses instead of fetching over TLS.

import { up, mac } from "./up.js";
import * as config from "../../config/index.js";
import { tempHome } from "../../../test/helpers.js";

/** A VYRE_HOME for a Mac. The second argument is ignored: nothing here reads another product's status any more. */
function world(t, _status) {
  const home = tempHome(t);
  config.save({ role: "local" });
  return home;
}
const running = (_peers) => ({});
const peer = (_name, _user, _extra) => ({});

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
    // The home rule (a temp home never talks to a real box) is tested on its own below.
    mayReach: () => true,
  };
  return { deps, lines, calls, added, opened, text: () => lines.join("\n") };
}

const BOX = "https://vyre.example-tail.ts.net";

test("up --json on a Mac with no box: one object, box null, not ready", async t => {
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

test("up --json on a Mac with its box answering: ready, and the box named", async t => {
  world(t, running([]));
  config.save({ network: { box: BOX } });
  const f = fakes(t, { answering: [BOX] });
  assert.equal(await up(["--json"], f.deps), 0);
  const o = JSON.parse(f.lines[0]);
  assert.equal(f.lines.length, 1);
  assert.equal(o.box, BOX);
  assert.equal(o.ready, true);
  assert.equal(o.url, null);
});

test("up on a Mac with no terminal and no box: the three commands, exit 0", async t => {
  world(t, running([]));
  const f = fakes(t, { tty: false });
  assert.equal(await up([], f.deps), 0);
  for (const c of ["vyre box add user@host", "vyre up --box", "vyre up --connect <address>"]) assert.ok(f.text().includes(c), c);
  assert.doesNotMatch(f.text(), /\? /, "nothing asked");
});

test("up on a Mac: with a terminal and no box it asks where Vyre should run; choosing 1 hands the server to box add", async t => {
  world(t, running([]));
  const f = fakes(t, { answers: ["1", "alex@203.0.113.7"] });
  assert.equal(await up([], f.deps), 0);
  assert.match(f.text(), /Where should Vyre run\?/);
  assert.match(f.text(), /On a server I can SSH to/);
  assert.deepEqual(f.added, ["alex@203.0.113.7"]);
  assert.ok(!/tailscale|tailnet/i.test(f.text()), "no question names another product");
});

test("up on a Mac: choosing 3 saves the address given, as --connect does", async t => {
  world(t, running([]));
  const f = fakes(t, { answering: [BOX], answers: ["3", "vyre.example-tail.ts.net/"] });
  assert.equal(await up([], f.deps), 0);
  assert.equal(config.load().network.box, BOX);
  assert.match(f.text(), /Vyre is ready\./);
});

test("up on a Mac: a known box that does not answer says why and exits 1", async t => {
  world(t, running([]));
  config.save({ network: { box: BOX } });
  const f = fakes(t);
  assert.equal(await up([], f.deps), 1);
  assert.match(f.text(), /your box https:\/\/vyre\.example-tail\.ts\.net did not answer from here/);
  t.mock.restoreAll();

  const j = fakes(t);
  assert.equal(await up(["--json"], j.deps), 1);
  assert.equal(JSON.parse(j.lines[0]).error.code, "box_unreachable");
});

test("up on a Mac: a box named in config is never sent a pairing request by starting; --connect or a yes does it", async t => {
  world(t, running([]));
  config.save({ network: { box: BOX } });
  const tools = { "link.status": () => ({ data: { linked: false, pending: null } }), "link.pair": () => ({ data: { code: "123-456" } }) };
  // Starting, without a terminal: nothing is sent; the way to pair is named.
  const quiet = fakes(t, { answering: [BOX], tty: false, tools });
  assert.equal(await up([], quiet.deps), 0);
  assert.deepEqual(quiet.calls.map(c => c[0]), ["link.status", "capsule"]);
  assert.match(quiet.text(), /not paired with \S+ yet\. To pair it: vyre link pair/);
  t.mock.restoreAll();
  // On a terminal it asks; no (or nothing) sends nothing.
  const no = fakes(t, { answering: [BOX], answers: [""], tools });
  assert.equal(await up([], no.deps), 0);
  assert.ok(!no.calls.some(c => c[0] === "link.pair"));
  assert.match(no.text(), /\? +Pair this Mac with \S+\? It sends the box a request to approve\. \(y\/N\)/);
  t.mock.restoreAll();
  const yes = fakes(t, { answering: [BOX], answers: ["y"], tools });
  assert.equal(await up([], yes.deps), 0);
  assert.ok(yes.calls.some(c => c[0] === "link.pair"));
  assert.match(yes.text(), /Approve this Mac on your phone at \S+[\s\S]*Code: 123-456/);
  t.mock.restoreAll();
  // --connect is the person asking for this box: it pairs without a question.
  const connect = fakes(t, { answering: [BOX], tty: false, tools });
  assert.equal(await up(["--connect", BOX], connect.deps), 0);
  assert.deepEqual(connect.calls.map(c => c[0]), ["link.status", "link.pair", "capsule"]);
});

test("up on a Mac: a temp or dev home never talks to a real box unless told to", async t => {
  world(t, running([]));
  config.save({ network: { box: BOX } });
  const f = fakes(t, { answering: [BOX], tty: false, tools: { "link.status": () => ({ data: { linked: false, pending: null } }), "link.pair": () => ({ data: { code: "1" } }) } });
  f.deps.mayReach = () => false;
  assert.equal(await up(["--connect", BOX], f.deps), 1);
  assert.deepEqual(f.calls, [], "not even link.status");
  assert.match(f.text(), /is not ~\/\.vyre, so it does not talk to a real box; set VYRE_ALLOW_REAL_BOX=1/);
  // A box on this machine's loopback is a dev world's own.
  t.mock.restoreAll();
  const local = "https://127.0.0.1:7300";
  const g = fakes(t, { answering: [local], tty: false, tools: { "link.status": () => ({ data: { linked: false, pending: null } }), "link.pair": () => ({ data: { code: "1" } }) } });
  g.deps.mayReach = () => false;
  assert.equal(await up(["--connect", local], g.deps), 0);
  assert.ok(g.calls.some(c => c[0] === "link.pair"));
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
async function runMac(box, { healthy = true, status = { linked: false, pending: null }, pair = { code: "123-456" }, found = [], capsule = true, platform = "darwin", opened = true, io = undefined, explicit = false } = {}) {
  const calls = [], lines = [], saved = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  let code;
  try {
    code = await mac(box, { capsule, pair: explicit }, {
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
      mayReach: () => true,
    });
  } finally { console.log = log; }
  return { code, calls, saved, text: lines.join("\n") };
}

test("up on a Mac: no box given and none found says how to point at one, and does nothing else", async () => {
  const r = await runMac(undefined);
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls.map(c => c[0]), []);
  assert.deepEqual(r.saved, []);
  assert.match(r.text, /vyre up --connect/);
});

test("up on a Mac: an unreachable box stops before pairing or the Capsule", async () => {
  const r = await runMac("https://alex.vyre.run", { healthy: false });
  assert.equal(r.code, 1);
  assert.deepEqual(r.calls, []);
});

test("up on a Mac: asked to pair, it starts pairing, prints the code to approve, then opens the Capsule", async () => {
  const r = await runMac("https://alex.vyre.run", { explicit: true });
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls.map(c => c[0]), ["link.status", "link.pair", "capsule"]);
  assert.deepEqual(r.calls[1][1], { box: "https://alex.vyre.run" });
  assert.match(r.text, /Approve this Mac on your phone at \S+[\s\S]*Code: 123-456/);
});

test("up on a Mac: on a terminal the status line is offered before the Capsule; without one it is not", async () => {
  const tty = await runMac("https://alex.vyre.run", { io: { tty: true, ask: async () => "y" } });
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
  // Linked: the ending asks the box for its assistant, over the link.
  assert.deepEqual((await runMac("https://alex.vyre.run", { status: linked })).calls.map(c => c[0]), ["link.status", "capsule", "link.call"]);
  assert.deepEqual((await runMac("https://alex.vyre.run", { status: linked, capsule: false })).calls.map(c => c[0]), ["link.status", "link.call"]);
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
  config.save({ network: { box: BOX } });
  for (const breakIt of [
    d => { d.bring = async () => { throw new Error("bring broke"); }; },
    d => { d.call = async () => { throw new Error("tool broke"); }; },
  ]) {
    const f = fakes(t, { answering: [BOX] });
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
  const { version } = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../../package.json"), "utf8"));
  assert.ok(text.includes(`v·  Vyre is installed · ${version}`), "the welcome names the package's version");
  assert.match(text, /Vyre runs Claude Code on a machine you own/);
  assert.ok(text.indexOf("Vyre is installed") < text.indexOf("Where should Vyre run?"), "the welcome comes first");
  assert.match(text, /1  On a server I can SSH to[\s\S]*2  On this Mac[\s\S]*3  I already set up a box/);
  assert.match(text, /Asking https:\/\/vyre\.example-tail\.ts\.net to pair with this Mac/);
  assert.match(text, /Approve this Mac on your phone at https:\/\/vyre\.example-tail\.ts\.net[\s\S]*Code: 123-456/);
  assert.doesNotMatch(text, /vyred running ·/, "a first run gets the welcome, not a status line");
  assert.deepEqual(f.opened, [], "nothing is opened in a browser");
});
