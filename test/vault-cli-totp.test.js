// @ts-check
// `vyre vault totp` live, and the vault verbs the Deck had first (health, breach, history,
// revert, clear-clipboard). The countdown is a pure frame plus a loop driven here by a fake clock
// and a fake terminal: it redraws each second from the local clock and calls vault.totp once per
// period, whatever the period. The verbs run against a real vyred in a temp home whose verifier
// finds a person at every call, with a fake api.pwnedpasswords.com so nothing leaves the machine.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { groupCode, periodEnd, totpFrame, liveTotp, TOTP_LIVE_MS } from "../core/cli/commands/vault.js";
import { totp } from "../core/vault/totp.js";
import { ping } from "../core/daemon/index.js";
import * as config from "../core/config/index.js";
import { SCRATCH } from "./scratch.mjs";
import { stopDaemon } from "./helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "vyre");
const plain = s => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

// ------------------------------------------------------------ the frame

test("vault totp: codes are grouped as the Deck groups them", () => {
  assert.equal(groupCode("123456"), "123 456");
  assert.equal(groupCode("12345678"), "1234 5678");
  assert.equal(groupCode("12345"), "12345");
  assert.equal(groupCode(undefined), "");
});

test("vault totp: the period's end snaps to the epoch boundary, for any period", () => {
  // Fetched 20.4 s into a 30 s period: the tool says 10 s left (whole seconds); the end is at 30 s.
  assert.equal(periodEnd(1_800_020_400, 10, 30), 1_800_030_000);
  // A 60 s period, fetched 0.9 s into it.
  assert.equal(periodEnd(1_800_000_900, 60, 60), 1_800_060_000);
});

test("vault totp: one frame is the grouped code, a bar of the seconds left, and the count", () => {
  const end = 1_800_030_000;
  const f = totpFrame({ now: end - 15_000, endsAt: end, period: 30, code: "492039", paint: false });
  assert.equal(f.left, 15);
  assert.equal(f.line, "  492 039  " + "█".repeat(10) + "░".repeat(10) + " 15s");
  // A 60 s period is not drawn as 30.
  const g = totpFrame({ now: end - 15_000, endsAt: end, period: 60, code: "492039", paint: false });
  assert.equal(g.left, 15);
  assert.match(g.line, new RegExp("█{5}░{15} 15s$"));
  // Past the end it reads 0, never negative; a next code is shown only when there is one.
  assert.equal(totpFrame({ now: end + 3000, endsAt: end, period: 30, code: "1", paint: false }).left, 0);
  assert.match(totpFrame({ now: end - 1000, endsAt: end, period: 30, code: "111111", next: "222222", paint: false }).line, /next 222 222$/);
  assert.doesNotMatch(f.line, /next/);
});

// ------------------------------------------------------------ the loop

/** A terminal and a clock the test moves by hand. */
function fakeTerminal(start) {
  let t = start;
  /** @type {null | (() => void)} */ let tick = null;
  /** @type {null | (() => void)} */ let quit = null;
  /** @type {null | undefined | (() => void)} */ let enter = null;
  const writes = [];
  let keyAttaches = 0;
  const io = {
    now: () => t,
    write: s => { writes.push(s); },
    every: (_ms, fn) => { tick = fn; return () => { tick = null; }; },
    keys: (q, e) => { quit = q; enter = e; keyAttaches++; return () => { quit = null; enter = null; }; },
  };
  const settle = () => new Promise(r => setImmediate(r));
  return {
    io, writes,
    get keyAttaches() { return keyAttaches; },
    get listening() { return quit !== null; },
    get ticking() { return tick !== null; },
    /** Move the clock a second at a time, running the one-second tick as the real timer would. */
    async advance(ms) {
      for (let i = 0; i < ms / 1000; i++) { t += 1000; if (tick) { tick(); await settle(); await settle(); } }
    },
    press() { if (quit) quit(); },
    enter() { if (enter) enter(); },
    frame() { const all = plain(writes.join("")); return all.slice(all.lastIndexOf("\r") + 1); },
  };
}

test("vault totp live: redraws from the local clock and calls vault.totp once per period", async () => {
  const start = 1_800_000_000_000 + 20_400; // 20.4 s into a 30 s period
  const term = fakeTerminal(start);
  let calls = 0;
  const fetch = async () => {
    calls++;
    const now = term.io.now();
    return { data: { code: String(100000 + calls), period: 30, remaining: 30 - (Math.floor(now / 1000) % 30) } };
  };
  const done = liveTotp({ code: "100000", period: 30, remaining: 10 }, { fetch, io: term.io, paint: false, auto: true });
  assert.match(term.frame(), /^ {2}100 000 {2}█+░+ 10s$/);
  assert.match(term.writes[0], /\x1b\[\?25l/, "the cursor is hidden while it draws");

  await term.advance(5000);
  assert.match(term.frame(), / 5s$/);
  assert.equal(calls, 0, "no call inside a period");

  await term.advance(5000); // the period rolls over
  assert.equal(calls, 1);
  assert.match(term.frame(), /^ {2}100 001 .* 30s$/);
  assert.ok(term.listening, "the key reader is back after the fetch");

  await term.advance(90_000); // three more periods
  assert.equal(calls, 4, "one call per period, never one a second");

  term.press();
  assert.equal(await done, 0);
  assert.ok(!term.ticking && !term.listening, "the timer and the key reader are stopped");
  assert.match(term.writes.at(-1), /\x1b\[\?25h\n$/, "the cursor is restored");
});

test("vault totp live: a 60 s period is honoured, and it stops by itself after five minutes", async () => {
  const start = 1_800_000_000_000; // on a 60 s boundary
  const term = fakeTerminal(start);
  let calls = 0;
  const fetch = async () => { calls++; return { data: { code: "654321", period: 60, remaining: 60 - (Math.floor(term.io.now() / 1000) % 60) } }; };
  const done = liveTotp({ code: "123456", period: 60, remaining: 60 }, { fetch, io: term.io, paint: false, name: "harlow-mail", auto: true });
  await term.advance(30_000);
  assert.match(term.frame(), / 30s$/);
  assert.equal(calls, 0, "30 s into a 60 s period is not a rollover");
  await term.advance(TOTP_LIVE_MS);
  assert.equal(await done, 0);
  assert.equal(calls, 4, "one call at each minute boundary until five minutes");
  assert.match(plain(term.writes.join("")), /stopped after 5 minutes · vyre vault totp harlow-mail for more/);
  assert.ok(!term.ticking && !term.listening);
});

test("vault totp live: a failed fetch ends it with the vault's exit code, and a vyred clock behind ours costs no extra call", async () => {
  const term = fakeTerminal(1_800_000_000_000 + 29_000);
  const answers = [
    // vyred still in the old period: the same boundary comes back.
    { data: { code: "111111", period: 30, remaining: 1 } },
    { error: { code: "locked", message: "the vault is locked" } },
  ];
  let calls = 0;
  const done = liveTotp({ code: "000000", period: 30, remaining: 1 }, { fetch: async () => answers[calls++], io: term.io, paint: false, auto: true });
  await term.advance(1000);
  assert.equal(calls, 1);
  await term.advance(10_000);
  assert.equal(calls, 1, "the next call waits for the next period, not the next second");
  await term.advance(20_000);
  assert.equal(calls, 2);
  assert.equal(await done, 4);
  assert.match(plain(term.writes.join("")), /locked: the vault is locked/);
});

test("vault totp live: from a terminal the next code waits for Enter, since each code asks for its own proof", async () => {
  const term = fakeTerminal(1_800_000_000_000 + 25_000);
  let calls = 0;
  const fetch = async () => { calls++; return { data: { code: "222222", period: 30, remaining: 30 - (Math.floor(term.io.now() / 1000) % 30) } }; };
  const done = liveTotp({ code: "111111", period: 30, remaining: 5 }, { fetch, io: term.io, paint: false });
  term.enter();
  assert.equal(calls, 0, "Enter inside a period does nothing");
  await term.advance(10_000);
  assert.equal(calls, 0, "no call when the period ends");
  assert.match(term.frame(), /expired · Enter for a new code \(asks again\) · q quits/);
  assert.doesNotMatch(term.frame(), /111 111/, "the old code is gone");
  term.enter();
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.equal(calls, 1);
  assert.match(term.frame(), /222 222/);
  term.press();
  assert.equal(await done, 0);
});

// ------------------------------------------------------------ the verbs, against vyred

const BREACHED = "fixture-breached-pw";

/** A fetch for vyred that plays api.pwnedpasswords.com: BREACHED is in a breach, nothing else is. */
const FAKE_FETCH = `import crypto from "node:crypto";
const hit = crypto.createHash("sha1").update(${JSON.stringify(BREACHED)}).digest("hex").toUpperCase();
globalThis.fetch = async url => {
  const u = String(url);
  if (!u.startsWith("https://api.pwnedpasswords.com/range/")) throw new Error("no network in this test");
  const prefix = u.slice(-5);
  const body = (prefix === hit.slice(0, 5) ? hit.slice(5) + ":42\\r\\n" : "") + "0123456789ABCDEF0123456789ABCDEF012:0\\r\\n";
  return { ok: true, status: 200, text: async () => body };
};
`;

/** vyred for a temp home with the test verifier and the fake breach service; stopped after the test. */
async function vyred(t, vaultConfig) {
  const h = fs.mkdtempSync(path.join(SCRATCH, "vyre-totp-"));
  if (path.resolve(h) === path.resolve(os.homedir(), ".vyre")) throw new Error("a test tried to use the real ~/.vyre");
  fs.writeFileSync(path.join(h, "config.json"), JSON.stringify({ transcripts: [], vault: { keystore: "file", ...vaultConfig } }));
  const fakeFetch = path.join(h, "fake-fetch.mjs");
  fs.writeFileSync(fakeFetch, FAKE_FETCH);
  const p = config.ensure(h);
  const fd = fs.openSync(path.join(p.logs, "vyred.out"), "a");
  const child = spawn(process.execPath, ["--import", fakeFetch, path.join(HERE, "fixtures", "vyred-present.js")],
    { detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, VYRE_HOME: h, VYRE_NO_DIALOGS: "1" } });
  child.unref();
  // stopDaemon reads vyred.pid out of h itself (written by the same core/daemon/index.js start()
  // vyred-present.js runs), escalates to SIGKILL and confirms the process is actually gone before
  // returning - this used to be its own weaker copy here (SIGTERM, a bounded wait, then rmSync
  // regardless of whether the process had actually exited), the exact "deleted a home out from
  // under a still-running vyred" bug tempHome's own stopDaemon was already hardened against.
  t.after(async () => { await stopDaemon(h); fs.rmSync(h, { recursive: true, force: true }); });
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (await ping(p.socket)) return h;
    if (child.exitCode !== null) break;
  }
  throw new Error("vyred did not start: " + fs.readFileSync(path.join(p.logs, "vyred.out"), "utf8"));
}

/** `vyre` as a script runs it: pipes, no terminal. */
function vyre(home, args, input = "") {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: home, NO_COLOR: "1" } });
    let out = "", err = "";
    p.stdout.on("data", c => { out += c; });
    p.stderr.on("data", c => { err += c; });
    p.on("close", code => resolve({ code, out, err, all: out + err }));
    p.stdin.end(input);
  });
}

const put = (home, item) => vyre(home, ["call", "vault.put", JSON.stringify(item)]);

test("vault cli: totp --json and piped print one result and exit, with the item's own period", async t => {
  const home = await vyred(t, {});
  const seed = "JBSWY3DPEHPK3PXP";
  assert.equal((await put(home, { name: "harlow-mail", kind: "login", fields: { username: "alex", password: crypto.randomBytes(12).toString("hex"), totp: seed } })).code, 0);
  assert.equal((await put(home, { name: "northwind-bank", kind: "login", fields: { username: "alex", password: crypto.randomBytes(12).toString("hex"), totp: `otpauth://totp/Northwind:alex?secret=${seed}&period=60` } })).code, 0);

  const j = await vyre(home, ["vault", "totp", "harlow-mail", "--json"]);
  assert.equal(j.code, 0, j.all);
  const d = JSON.parse(j.out).data;
  assert.deepEqual(Object.keys(d).sort(), ["code", "next", "period", "remaining"], "the next code rides along, so a rollover is never a guess (ADR 0028)");
  assert.equal(d.period, 30);
  const now = Date.now();
  assert.ok([totp(seed, { at: now }).code, totp(seed, { at: now - 30_000 }).code].includes(d.code));

  const sixty = JSON.parse((await vyre(home, ["vault", "get", "northwind-bank", "--otp", "--json"])).out).data;
  assert.equal(sixty.period, 60);
  assert.ok(sixty.remaining > 0 && sixty.remaining <= 60);

  // Piped: the code alone on stdout, ungrouped, for $(...); no redraws, no cursor codes.
  const piped = await vyre(home, ["vault", "totp", "harlow-mail"]);
  assert.equal(piped.code, 0, piped.all);
  assert.match(piped.out, /^\d{6}\n$/);
  assert.match(piped.err, /\d+s left/);
  assert.doesNotMatch(piped.all, /\x1b/);
  assert.equal((await vyre(home, ["vault", "totp", "harlow-mail", "--once"])).code, 0);
});

test("vault cli: health, history, revert and clear-clipboard against vyred", async t => {
  const home = await vyred(t, {});
  const shared = crypto.randomBytes(16).toString("hex");
  assert.equal((await put(home, { name: "harlow-portal", kind: "login", fields: { username: "alex", password: "abc" } })).code, 0);
  assert.equal((await put(home, { name: "northwind-shop", kind: "login", fields: { username: "alex", password: shared } })).code, 0);
  assert.equal((await put(home, { name: "northwind-admin", kind: "login", fields: { username: "kit", password: shared } })).code, 0);

  // health: counts and names, never a value.
  const hj = await vyre(home, ["vault", "health", "--json"]);
  assert.equal(hj.code, 0, hj.all);
  const h = JSON.parse(hj.out).data;
  assert.equal(h.checked, 3);
  assert.equal(h.counts.weak, 1);
  assert.equal(h.counts.reused, 2);
  const hh = await vyre(home, ["vault", "health"]);
  assert.equal(hh.code, 0, hh.all);
  assert.match(hh.out, /Watchtower · 3 items checked/);
  assert.match(hh.out, /1 weak · 2 reused · 0 rotate · 0 old/);
  assert.match(hh.out, /weak · easy to guess[^\n]*\n\s+harlow-portal\s+login/);
  assert.match(hh.out, /reused · [^\n]*\n\s+northwind-(shop|admin), northwind-(shop|admin) · same value/);
  for (const v of ["abc", shared]) assert.ok(!hh.all.includes(v) && !hj.all.includes(v), "health printed a value");

  // history and revert: a changed password, then the first one put back.
  const second = crypto.randomBytes(16).toString("hex");
  assert.equal((await vyre(home, ["vault", "edit", "northwind-shop", "--field", "password"], second + "\n")).code, 0);
  const hist = await vyre(home, ["vault", "history", "northwind-shop"]);
  assert.equal(hist.code, 0, hist.all);
  assert.match(hist.out, /v2\s+current .* password/);
  assert.match(hist.out, /v1\s+kept/);
  assert.match(hist.out, /vyre vault revert northwind-shop <version>/);
  const histJson = JSON.parse((await vyre(home, ["vault", "history", "northwind-shop", "--field", "password", "--json"])).out).data;
  assert.deepEqual(histJson.entries.map(e => e.version), [2, 1]);
  assert.ok(!hist.all.includes(second) && !hist.all.includes(shared));

  assert.equal((await vyre(home, ["vault", "revert", "northwind-shop", "x"])).code, 1);
  const rev = await vyre(home, ["vault", "revert", "northwind-shop", "1"]);
  assert.equal(rev.code, 0, rev.all);
  assert.match(rev.out, /reverted northwind-shop · version 1 is back, as version 3/);
  const back = await vyre(home, ["vault", "get", "northwind-shop", "--reveal", "--field", "password", "--json"]);
  assert.equal(JSON.parse(back.out).data.value, shared);
  const revJson = JSON.parse((await vyre(home, ["vault", "revert", "northwind-shop", "2", "--json"])).out);
  assert.deepEqual(revJson.data, { name: "northwind-shop", version: 4, from: 2 });

  const miss = await vyre(home, ["vault", "history", "no-such-item", "--json"]);
  assert.equal(miss.code, 1);
  assert.ok(JSON.parse(miss.out).error);

  const clr = await vyre(home, ["vault", "clear-clipboard"]);
  assert.equal(clr.code, 0, clr.all);
  assert.match(clr.out, /cleared/);
  assert.deepEqual(JSON.parse((await vyre(home, ["vault", "clear-clipboard", "--json"])).out), { data: { cleared: true } });
});

test("vault cli: breach is off until the config asks for it, then names what a (fake) breach service knows", async t => {
  const off = await vyred(t, {});
  const o = await vyre(off, ["vault", "breach"]);
  assert.equal(o.code, 1);
  assert.match(o.out, /the breach check is off · set "vault": \{ "breach": "ask" \} in config.json/);
  assert.match(JSON.parse((await vyre(off, ["vault", "breach", "--json"])).out).error.message, /breach check is off/);
  assert.equal((await vyre(off, ["vault", "breach", "harlow-mail"])).code, 1, "breach takes no item");

  const on = await vyred(t, { breach: "ask" });
  assert.match((await vyre(on, ["vault", "breach"])).out, /none found · none of 0 passwords/);
  assert.equal((await put(on, { name: "harlow-mail", kind: "login", fields: { username: "alex", password: BREACHED } })).code, 0);
  assert.equal((await put(on, { name: "northwind-shop", kind: "login", fields: { username: "juno", password: crypto.randomBytes(16).toString("hex") } })).code, 0);
  const b = await vyre(on, ["vault", "breach"]);
  assert.equal(b.code, 0, b.all);
  assert.match(b.out, /1 of 2 passwords appear in known breaches/);
  assert.match(b.out, /\n\s+harlow-mail\n/);
  assert.doesNotMatch(b.out, /northwind-shop/);
  assert.ok(!b.all.includes(BREACHED));
  const bj = JSON.parse((await vyre(on, ["vault", "breach", "--json"])).out).data;
  assert.deepEqual(bj.breached, ["harlow-mail"]);
  assert.equal(bj.checked, 2);
});
