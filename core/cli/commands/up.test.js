// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse, envCandidates } from "./up.js";
import { SCRATCH } from "../../../test/scratch.mjs";

test("up: flags with and without values", () => {
  assert.deepEqual(parse(["--system", "--user", "alex", "--dry-run"]), { flags: { system: true, user: "alex", "dry-run": true }, rest: [] });
  assert.deepEqual(parse(["--user=alex", "file"]), { flags: { user: "alex" }, rest: ["file"] });
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

test("up on a Mac: a box named in config is never sent anything by starting; an unpaired Mac is told how to pair with a code", async t => {
  world(t, running([]));
  config.save({ network: { box: BOX } });
  const tools = { "wink.server.home": () => ({ data: { linked: false } }) };
  const quiet = fakes(t, { answering: [BOX], tty: false, tools });
  assert.equal(await up([], quiet.deps), 0);
  assert.deepEqual(quiet.calls.map(c => c[0]), ["wink.server.home", "capsule"]);
  assert.match(quiet.text(), /not paired with \S+ yet\..*wink\.server\.code.*vyre link pair <code>/);
  t.mock.restoreAll();
  // On a terminal nothing is asked either: there is no request to send, only a code to give.
  const tty = fakes(t, { answering: [BOX], answers: ["y"], tools });
  assert.equal(await up([], tty.deps), 0);
  assert.ok(!tty.text().includes("? "), "no question is asked");
  t.mock.restoreAll();
  // --connect saves the address and sends nothing.
  const connect = fakes(t, { answering: [BOX], tty: false, tools });
  assert.equal(await up(["--connect", BOX], connect.deps), 0);
  assert.deepEqual(connect.calls.map(c => c[0]), ["wink.server.home", "capsule"]);
});

test("up on a Mac: a temp or dev home never talks to a real box unless told to", async t => {
  world(t, running([]));
  config.save({ network: { box: BOX } });
  const f = fakes(t, { answering: [BOX], tty: false, tools: { "wink.server.home": () => ({ data: { linked: false } }) } });
  f.deps.mayReach = () => false;
  assert.equal(await up(["--connect", BOX], f.deps), 1);
  assert.deepEqual(f.calls, [], "not even wink.server.home");
  assert.match(f.text(), /is not ~\/\.vyre, so it does not talk to a real box; set VYRE_ALLOW_REAL_BOX=1/);
  // A box on this machine's loopback is a dev world's own.
  t.mock.restoreAll();
  const local = "https://127.0.0.1:7300";
  const g = fakes(t, { answering: [local], tty: false, tools: { "wink.server.home": () => ({ data: { linked: false } }) } });
  g.deps.mayReach = () => false;
  assert.equal(await up(["--connect", local], g.deps), 0);
  assert.ok(g.calls.some(c => c[0] === "wink.server.home"));
});

test("up on a server: no link and no browser; unpaired it says how to pair, paired it names the space", async t => {
  world(t, running([]));
  config.save({ role: "box" });
  // no terminal: it says how to pair (on a terminal it runs the installer's pairing, pair-here.js, which has its own tests)
  const f = fakes(t, { tty: false, tools: { "wink.server.status": () => ({ data: { owned: false } }) } });
  f.deps.platform = "linux";
  assert.equal(await up([], f.deps), 0);
  assert.match(f.text(), /not paired yet\. Pair this server from your Vyre app: run vyre call wink\.server\.code/);
  assert.ok(!f.calls.some(c => c[0] === "onboard.link"), "no onboarding link is asked for");
  assert.deepEqual(f.opened, [], "nothing is opened");
  t.mock.restoreAll();

  const p = fakes(t, { tools: { "wink.server.status": () => ({ data: { owned: true, space: "alex", device: "Alex's phone" } }) } });
  assert.equal(await up([], p.deps), 0);
  assert.match(p.text(), /paired to alex/);
  t.mock.restoreAll();

  const j = fakes(t, { tools: { "wink.server.status": () => ({ data: { owned: true, space: "alex" } }) } });
  assert.equal(await up(["--json"], j.deps), 0);
  const o = JSON.parse(j.lines[0]);
  assert.deepEqual([o.role, o.paired, o.space, o.ready], ["box", true, "alex", true]);
});

test("up --keep-link on a server (vyre update): accepted, and it only reports whether the server is paired", async t => {
  world(t, running([]));
  config.save({ role: "box" });
  const f = fakes(t, { tools: { "wink.server.status": () => ({ data: { owned: false } }) } });
  assert.equal(await up(["--keep-link", "--json"], f.deps), 0);
  const o = JSON.parse(f.lines[0]);
  assert.equal(o.paired, false);
  assert.match(o.pairing, /wink\.server\.code/);
});

/** mac() with a fake box and link; returns what it called and printed. */
async function runMac(box, { healthy = true, status = { linked: false }, pair = { code: "123-456" }, found = [], capsule = true, platform = "darwin", opened = true, io = undefined, explicit = false } = {}) {
  const calls = [], lines = [], saved = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  let code;
  try {
    code = await mac(box, { capsule, pair: explicit }, {
      health: async () => healthy,
      tool: async (name, input) => {
        calls.push([name, input]);
        return name === "wink.server.home" ? { data: status } : name === "link.find" ? { data: { boxes: found, paired: null } } : { data: pair };
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

test("up on a Mac: an unpaired box is told how to pair, sends nothing, then opens the Capsule", async () => {
  const r = await runMac("https://alex.vyre.run", { explicit: true });
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls.map(c => c[0]), ["wink.server.home", "capsule"]);
  assert.match(r.text, /vyre link pair <code>/);
});

test("up on a Mac: on a terminal the status line is offered before the Capsule; without one it is not", async () => {
  const tty = await runMac("https://alex.vyre.run", { io: { tty: true, ask: async () => "y" } });
  assert.deepEqual(tty.calls.map(c => c[0]), ["wink.server.home", "statusline", "capsule"]);
  const piped = await runMac("https://alex.vyre.run", { io: { tty: false, ask: async () => "" } });
  assert.ok(!piped.calls.some(c => c[0] === "statusline"));
});

test("up on a Mac: already linked goes straight to the Capsule; --no-capsule skips it", async () => {
  const linked = { linked: true };
  // Linked: the ending asks the box for its assistant, over the link.
  assert.deepEqual((await runMac("https://alex.vyre.run", { status: linked })).calls.map(c => c[0]), ["wink.server.home", "capsule", "wink.server.call"]);
  assert.deepEqual((await runMac("https://alex.vyre.run", { status: linked, capsule: false })).calls.map(c => c[0]), ["wink.server.home", "wink.server.call"]);
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

test("up on a Mac, the very first time: the welcome, the three choices, and choice 3 saves the address and says how to pair", async t => {
  const home = world(t, running([]));
  fs.rmSync(path.join(home, "config.json"), { force: true });
  const f = fakes(t, { answering: [BOX], answers: ["3", "vyre.example-tail.ts.net"], tools: {
    "wink.server.home": () => ({ data: { linked: false } }),
  } });
  // --local stands in for a Mac's default role, so this runs the same on Linux.
  assert.equal(await up(["--local"], f.deps), 0);
  const text = f.text();
  const { version } = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../../package.json"), "utf8"));
  assert.ok(text.includes(`v·  Vyre is installed · ${version}`), "the welcome names the package's version");
  assert.match(text, /Vyre runs Claude Code on a machine you own/);
  assert.ok(text.indexOf("Vyre is installed") < text.indexOf("Where should Vyre run?"), "the welcome comes first");
  assert.match(text, /1  On a server I can SSH to[\s\S]*2  On this Mac[\s\S]*3  I already set up a box/);
  assert.match(text, /Saved https:\/\/vyre\.example-tail\.ts\.net\. To pair this Mac with it/);
  assert.match(text, /vyre link pair <code>/);
  assert.doesNotMatch(text, /vyred running ·/, "a first run gets the welcome, not a status line");
  assert.deepEqual(f.opened, [], "nothing is opened in a browser");
});
