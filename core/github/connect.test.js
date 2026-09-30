// @ts-check
// "Sign in with GitHub" (connect.js) against a fake `gh` binary and a fake api.github.com (no real
// network, no real GitHub account): the happy path, a decline, expiry, cancel, gh missing, no code
// shown, a name race, and that the private config folder is always removed, gh never sees the
// person's own environment, and no token ever reaches a result, an event or a log line.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connector, resolveGh } from "./connect.js";

const TOKEN = "gho_faketoken1234567890";

/**
 * A fake `gh`: `auth login` prints the code and address on stderr like the real one, then acts
 * per `mode` (approve after a beat | decline | hang | nocode); `auth token` prints what login
 * "stored" in the config folder. Every call is logged as JSON with the env it saw.
 */
function fakeGh(t, mode = "approve") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-fakegh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "calls.jsonl");
  const bin = path.join(dir, "gh");
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const a = process.argv.slice(2);
const cfg = process.env.GH_CONFIG_DIR || "";
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: a, home: process.env.HOME, cfg, ghToken: process.env.GH_TOKEN || null, githubToken: process.env.GITHUB_TOKEN || null, secret: process.env.VYRE_TEST_SECRET || null }) + "\\n");
if (a[0] === "auth" && a[1] === "login") {
  const mode = ${JSON.stringify(mode)};
  if (mode === "nocode") { console.error("error: no network"); process.exit(1); }
  console.error("\\n! First copy your one-time code: WXYZ-1234");
  console.error("Open this URL to continue in your web browser: https://github.com/login/device");
  if (mode === "hang") setInterval(() => {}, 1000);
  else if (mode === "decline") setTimeout(() => { console.error("X Authentication failed: access_denied"); process.exit(1); }, 30);
  else setTimeout(() => { fs.mkdirSync(cfg, { recursive: true }); fs.writeFileSync(path.join(cfg, "token"), ${JSON.stringify(TOKEN)}); process.exit(0); }, 30);
} else if (a[0] === "auth" && a[1] === "token") {
  process.stdout.write(fs.readFileSync(path.join(cfg, "token"), "utf8") + "\\n");
} else process.exit(2);
`, { mode: 0o755 });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);
  return { bin, calls };
}

function fakeFetch({ login = "alex" } = {}) {
  return async (url, opts) => {
    if (url === "https://api.github.com/user") {
      assert.equal(opts.headers.authorization, `Bearer ${TOKEN}`);
      const body = { login, avatar_url: `https://avatars.example/${login}.png` };
      return { ok: true, status: 200, json: async () => body };
    }
    throw new Error(`fake github: unexpected url ${url}`);
  };
}

/** A connector over a pretend vault and account list, recording everything that leaves it. */
function rig(t, gh, opts = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-ghtmp-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const accounts = [], saved = [], events = [], lines = [], out = [];
  const c = connector({ gh: gh.bin, tmpRoot, fetch: /** @type {any} */ (fakeFetch()),
    taken: name => accounts.some(a => a.name === name),
    save: async (item, fields) => { saved.push({ item, fields }); },
    add: async acct => { accounts.push(acct); },
    emit: (type, payload) => events.push({ type, payload }),
    log: (m, x) => lines.push(`${m} ${JSON.stringify(x || {})}`),
    ...opts,
  });
  t.after(() => c.stop());
  const keep = async p => { try { const r = await p; out.push(r); return r; } catch (e) { out.push(String(/** @type {any} */ (e).message)); throw e; } };
  return { c, tmpRoot, accounts, saved, events, lines, out, keep };
}

async function waitFor(events, type, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (events.some(e => e.type === type)) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`never saw ${type}`);
}

function assertNoLeak(r, secrets) {
  const everything = JSON.stringify([r.out, r.events, r.lines]);
  for (const v of secrets) assert.ok(!everything.includes(v), `a value leaked: ${String(v).slice(0, 12)}...`);
}

test("connect: the real gh flow - code shown, gh finishes, token read once, saved, account added, folder removed, nothing leaks, the person's own env never reaches gh", async t => {
  process.env.GH_TOKEN = "person-own-token-should-not-pass"; process.env.VYRE_TEST_SECRET = "person-secret";
  t.after(() => { delete process.env.GH_TOKEN; delete process.env.VYRE_TEST_SECRET; });
  const gh = fakeGh(t, "approve");
  const r = rig(t, gh);
  const started = await r.keep(r.c.start({ name: "home" }));
  assert.deepEqual(Object.keys(started).sort(), ["expires_in", "id", "interval", "user_code", "verification_uri"]);
  assert.equal(started.user_code, "WXYZ-1234");
  assert.equal(started.verification_uri, "https://github.com/login/device");
  assert.equal(r.c.status(started.id), "pending");

  await waitFor(r.events, "github.connected");
  assert.deepEqual(r.saved, [{ item: "github-home", fields: { token: TOKEN } }]);
  assert.deepEqual(r.accounts[0], { name: "home", login: "alex", avatar_url: "https://avatars.example/alex.png", item: "github-home" });
  assert.equal(r.c.status(started.id), "used");
  assert.deepEqual(fs.readdirSync(r.tmpRoot), [], "the private gh folder is gone");

  const [login, token] = gh.calls();
  for (const flag of ["--web", "--insecure-storage", "--skip-ssh-key"]) assert.ok(login.args.includes(flag), flag);
  assert.equal(login.args[login.args.indexOf("--scopes") + 1], "repo");
  assert.deepEqual(token.args, ["auth", "token", "--hostname", "github.com"]);
  for (const call of [login, token]) {
    assert.equal(call.ghToken, null); assert.equal(call.githubToken, null); assert.equal(call.secret, null);
    assert.equal(call.cfg, path.join(call.home, "cfg"));
    assert.ok(call.home.startsWith(r.tmpRoot), "HOME is the private folder, not the person's");
  }
  assertNoLeak(r, [TOKEN]);
});

test("connect: a decline ends the sign-in in plain words, saves nothing, removes the folder", async t => {
  const r = rig(t, fakeGh(t, "decline"));
  await r.keep(r.c.start({ name: "home" }));
  await waitFor(r.events, "github.connect-failed");
  assert.equal(r.saved.length, 0);
  assert.match(r.events.find(e => e.type === "github.connect-failed").payload.error, /declined/);
  assert.deepEqual(fs.readdirSync(r.tmpRoot), []);
});

test("connect: a code that is never approved ends as expired and stops gh", async t => {
  const r = rig(t, fakeGh(t, "hang"), { expiresMs: 150 });
  const started = await r.keep(r.c.start({ name: "home" }));
  await waitFor(r.events, "github.connect-failed");
  assert.match(r.events.find(e => e.type === "github.connect-failed").payload.error, /expired/);
  assert.equal(r.c.status(started.id), "expired");
  assert.deepEqual(fs.readdirSync(r.tmpRoot), []);
});

test("connect: cancel ends an open sign-in; a stale id afterwards gets a plain answer, not \"no such sign-in\"", async t => {
  const r = rig(t, fakeGh(t, "hang"));
  const started = await r.keep(r.c.start({ name: "home" }));
  assert.deepEqual(await r.keep(r.c.cancel({ id: started.id })), { cancelled: true });
  await assert.rejects(r.keep(r.c.cancel({ id: started.id })), /cancelled/);
  assert.equal(r.saved.length, 0);
  assert.deepEqual(fs.readdirSync(r.tmpRoot), []);
});

test("connect: gh not installed is a clear gh_missing, with no folder left behind", async t => {
  const r = rig(t, { bin: path.join(os.tmpdir(), "vyre-no-such-gh-binary") });
  await assert.rejects(r.c.start({ name: "home" }), e => e.code === "gh_missing" && /GitHub CLI/.test(e.message));
  assert.deepEqual(fs.readdirSync(r.tmpRoot), []);
});

test("connect: gh that exits before showing a code is refused, not left hanging", async t => {
  const r = rig(t, fakeGh(t, "nocode"));
  await assert.rejects(r.c.start({ name: "home" }), e => e.code === "refused");
  assert.deepEqual(fs.readdirSync(r.tmpRoot), []);
});

test("connect: stop() ends every open sign-in and removes its folder", async t => {
  const r = rig(t, fakeGh(t, "hang"));
  await r.c.start({ name: "home" });
  assert.equal(fs.readdirSync(r.tmpRoot).length, 1);
  r.c.stop();
  assert.deepEqual(fs.readdirSync(r.tmpRoot), []);
});

test("connect: a name already taken, or a second sign-in for the same name, is refused up front", async t => {
  const r = rig(t, fakeGh(t, "hang"), { taken: name => name === "home" });
  await assert.rejects(r.keep(r.c.start({ name: "home" })), /already connected/);
  const r2 = rig(t, fakeGh(t, "hang"));
  await r2.c.start({ name: "work" });
  await assert.rejects(r2.c.start({ name: "work" }), /already open/);
});

test("connect: a name taken by another sign-in finishing first is caught at the end too (a race, not just at start)", async t => {
  let takenNow = false;
  const r = rig(t, fakeGh(t, "approve"), { taken: name => takenNow && name === "home" });
  await r.keep(r.c.start({ name: "home" }));
  takenNow = true;
  await waitFor(r.events, "github.connect-failed");
  assert.match(r.events.find(e => e.type === "github.connect-failed").payload.error, /added while you signed in/);
  assert.equal(r.saved.length, 0);
  assert.deepEqual(fs.readdirSync(r.tmpRoot), []);
});

// No revoke() test here: 0.2 dropped server-side revoke entirely (connect.js's own comment says
// why). github.remove's own test covers local-only removal.

test("resolveGh: an absolute path is used as given; a bare name is found only in system folders or a PATH folder the user cannot write, never a user-writable one", t => {
  assert.equal(resolveGh("/opt/tools/gh"), "/opt/tools/gh");
  assert.equal(resolveGh("sub/gh"), null);
  const planted = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-planted-"));
  t.after(() => fs.rmSync(planted, { recursive: true, force: true }));
  fs.writeFileSync(path.join(planted, "vyre-planted-gh"), "#!/bin/sh\n", { mode: 0o755 });
  const was = process.env.PATH;
  t.after(() => { process.env.PATH = was; });
  process.env.PATH = `${planted}${path.delimiter}${was}`;
  assert.equal(resolveGh("vyre-planted-gh"), null, "a planted binary in a writable PATH folder is ignored");
});

const PAT = "github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789ABCDEFGH";

test("paste: a pasted token is checked with GitHub first, then saved and the account added, with no gh and no leak", async t => {
  const r = rig(t, { bin: path.join(os.tmpdir(), "vyre-no-such-gh-binary") }, {
    fetch: /** @type {any} */ (async (url, opts) => {
      assert.equal(opts.headers.authorization, `Bearer ${PAT}`);
      if (String(url).startsWith("https://api.github.com/user/repos")) return { ok: true, status: 200, headers: { get: () => '<https://api.github.com/user/repos?per_page=1&page=7>; rel="next", <https://api.github.com/user/repos?per_page=1&page=7>; rel="last"' }, json: async () => [{}] };
      assert.equal(url, "https://api.github.com/user");
      return { ok: true, status: 200, json: async () => ({ login: "sam", avatar_url: "https://avatars.example/sam.png" }) };
    }),
  });
  const out = await r.keep(r.c.paste({ name: "work", token: `  ${PAT}\n` }));
  assert.deepEqual([out.connected, out.name, out.login, out.repos], [true, "work", "sam", 7]);
  assert.deepEqual(r.saved, [{ item: "github-work", fields: { token: PAT } }]);
  assert.deepEqual(r.accounts[0], { name: "work", login: "sam", avatar_url: "https://avatars.example/sam.png", item: "github-work" });
  assert.ok(r.events.some(e => e.type === "github.connected" && e.payload.login === "sam"));
  assertNoLeak(r, [PAT]);
});

test("paste: a token GitHub rejects saves nothing and says so plainly; a malformed one or a taken name is refused before any request", async t => {
  let requests = 0;
  const r = rig(t, { bin: "/none" }, { fetch: /** @type {any} */ (async () => { requests++; return { ok: false, status: 401, json: async () => ({ message: `Bad credentials ${PAT}` }) }; }) });
  await assert.rejects(r.keep(r.c.paste({ name: "work", token: PAT })), e => e.code === "refused" && /did not accept that token/.test(e.message) && !e.message.includes(PAT));
  assert.equal(r.saved.length, 0);
  assert.equal(r.accounts.length, 0);
  await assert.rejects(r.c.paste({ name: "work", token: "short" }), /does not look like a GitHub token/);
  await assert.rejects(r.c.paste({ name: "work", token: `${PAT} extra words` }), /does not look like a GitHub token/);
  await assert.rejects(r.c.paste({ name: "Bad Name", token: PAT }), /name must be/);
  const taken = rig(t, { bin: "/none" }, { taken: n => n === "work" });
  await assert.rejects(taken.c.paste({ name: "work", token: PAT }), /already connected/);
  assert.equal(requests, 1, "only the well-formed paste for a free name reached GitHub");
  assertNoLeak(r, [PAT]);
});
