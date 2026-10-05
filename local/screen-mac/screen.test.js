// @ts-check
// The screen module's own logic against a fake helper binary: the real runner process handling
// (ids, change lines, a crash, a timeout), the cache and its invalidation, redaction done again
// in node, the floor's blind places, and screenshots, all without reading a real screen.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeHelper, ScreenError } from "./runner.js";
import { Screen, shape } from "./screen.js";
import { tempHome } from "../../test/helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "fake-sight.js");

const NOTES = {
  where: { app: { name: "Notes", bundle: "com.apple.Notes", pid: 4242 }, window: { title: "Northwind Bakery order", frame: { x: 0, y: 0, w: 800, h: 600 } }, url: null },
  context: {
    app: { name: "Notes", bundle: "com.apple.Notes", pid: 4242 }, window: { title: "Northwind Bakery order", frame: { x: 0, y: 0, w: 800, h: 600 } },
    focused: { role: "AXTextArea", subrole: null, name: "Body", value: "two dozen rolls", selectedText: "rolls", frame: { x: 1, y: 2, w: 3, h: 4 } },
    url: null, text: "Northwind Bakery order\ntwo dozen rolls", truncated: false, secure: false, at: 1,
  },
};

/** A helper running the fake binary with a scenario, stopped when the test ends. */
function fake(t, scenario = {}, o = {}) {
  const state = tempHome(t);
  const helper = makeHelper({ bin: FAKE, timeoutMs: 2000, platform: "darwin", responsible: () => "Terminal", env: { ...process.env, FAKE_SIGHT: JSON.stringify({ ...NOTES, state, ...scenario }) }, ...o });
  t.after(() => helper.stop());
  return helper;
}

const counts = async helper => (await helper.request({ cmd: "fake.count" })).count;

test("context: answers from the helper and caches until a change line arrives", async t => {
  const helper = fake(t);
  const s = new Screen({ helper });
  const a = await s.context({ text: false });
  assert.equal(a.window.title, "Northwind Bakery order");
  assert.equal(a.focused.value, "two dozen rolls");
  assert.equal(a.cached, false);
  const b = await s.context({ text: false });
  assert.equal(b.cached, true);
  assert.deepEqual(await counts(helper), { where: 1, context: 1, "fake.count": 1 });

  await helper.request({ cmd: "fake.change" });
  const c = await s.context({ text: false });
  assert.equal(c.cached, false, "a change line did not invalidate the cache");
  const n = await counts(helper);
  assert.equal(n.where, 2); assert.equal(n.context, 2);
});

test("context: visible text ages out even without a change line", async t => {
  const helper = fake(t);
  let now = 1000;
  const s = new Screen({ helper, now: () => now, maxAgeMs: 2000 });
  await s.context();
  assert.equal((await s.context()).cached, true);
  now += 2500;
  assert.equal((await s.context()).cached, false);
  const n = await counts(helper);
  assert.equal(n.context, 2, "text older than maxAgeMs was served from the cache");
  assert.equal(n.where, 1, "where changes only on notifications, so it should still be cached");
});

test("context: passes text and a clamped textMax to the helper", async t => {
  const helper = fake(t);
  const s = new Screen({ helper });
  const r = /** @type {any} */ (await s.context({ textMax: 999999 }));
  assert.equal(r.text, "Northwind Bakery order\ntwo dozen rolls");
  assert.equal("asked" in r, false, "a field the tool does not promise came through");
});

test("redaction: node strips a secure value even when a buggy helper sent one", async t => {
  const leak = "hunter2-test-only";
  for (const bad of [
    { secure: true, focused: { role: "AXTextField", value: leak, selectedText: leak } },
    { secure: false, focused: { role: "AXTextField", subrole: "AXSecureTextField", value: leak, selectedText: leak } },
    { secure: false, focused: { role: "AXSecureTextField", value: leak } },
  ]) {
    const helper = fake(t, { context: { ...NOTES.context, ...bad, extra: leak } });
    const r = await new Screen({ helper }).context();
    assert.equal(r.secure, true);
    assert.equal(JSON.stringify(r).includes(leak), false, JSON.stringify(bad));
    assert.equal(r.focused && "value" in r.focused, false);
  }
  assert.equal(JSON.stringify(shape({ secure: true, focused: { value: leak } })).includes(leak), false);
});

test("blind: a password manager gives the app and window title, and its text is never read", async t => {
  const where = { app: { name: "1Password", bundle: "com.1password.1password", pid: 7 }, window: { title: "Harlow Legal vault" }, url: null };
  const helper = fake(t, { where, context: { ...NOTES.context, ...where, text: "secret words" } });
  const r = /** @type {any} */ (await new Screen({ helper }).context());
  assert.deepEqual(r, { app: { name: "1Password", bundle: "com.1password.1password", pid: 7 }, window: { title: "Harlow Legal vault" }, blind: "a password manager" });
  assert.equal((await counts(helper)).context, undefined, "the helper was asked for the text of a blind place");
});

test("blind: the Deck on the paired box, found through wink.server.call and cached for a minute", async t => {
  const where = { app: { name: "Safari", bundle: "com.apple.Safari", pid: 8 }, window: { title: "Deck" }, url: "https://juno.example.ts.net/deck/vault" };
  const helper = fake(t, { where });
  const asked = [];
  let now = 0;
  const call = async tool => { asked.push(tool); return { data: { address: "https://juno.example.ts.net" } }; };
  const s = new Screen({ helper, call, now: () => now });
  const r = /** @type {any} */ (await s.context());
  assert.equal(r.blind, "a Vyre surface in the browser");
  assert.equal("url" in r, false, "a blind answer carried the URL");
  await s.context();
  assert.deepEqual(asked, ["wink.server.call"]);
  now += 61_000;
  await s.context();
  assert.deepEqual(asked, ["wink.server.call", "wink.server.call"]);
});

test("blind: no link means no box, and an ordinary page reads normally", async t => {
  const where = { app: { name: "Safari", bundle: "com.apple.Safari", pid: 8 }, window: { title: "Northwind Bakery" }, url: "https://northwind.example/menu" };
  const helper = fake(t, { where, context: { ...NOTES.context, ...where } });
  const r = await new Screen({ helper }).context();
  assert.equal(r.url, "https://northwind.example/menu");
  assert.equal("blind" in r, false);
});

test("blind: the floor judges the full read too, in case the front app changed in between", async t => {
  const blindApp = { app: { name: "Keychain Access", bundle: "com.apple.keychainaccess", pid: 9 }, window: { title: "login" } };
  const helper = fake(t, { context: { ...NOTES.context, ...blindApp, text: "secret words" } });
  const r = /** @type {any} */ (await new Screen({ helper }).context());
  assert.equal(r.blind, "a password manager");
  assert.equal(JSON.stringify(r).includes("secret words"), false);
});

test("runner: a helper that crashes is restarted and the request retried once", async t => {
  const helper = fake(t, { crashOnce: "context" });
  const s = new Screen({ helper });
  await helper.request({ cmd: "fake.count" });
  const first = helper.pid();
  const r = await s.context({ text: false });
  assert.equal(r.window.title, "Northwind Bakery order");
  assert.notEqual(helper.pid(), first, "the helper was not restarted");
});

test("runner: a timeout fails that call, kills the helper, and the next call gets a fresh one", async t => {
  const helper = fake(t, { hangOnce: "context" }, { timeoutMs: 1500 });
  const s = new Screen({ helper });
  await helper.request({ cmd: "fake.count" });
  const first = helper.pid();
  await assert.rejects(s.context(), e => e instanceof ScreenError && e.code === "timeout");
  const r = await s.context();
  assert.equal(r.text, "Northwind Bakery order\ntwo dozen rolls");
  assert.notEqual(helper.pid(), first);
});

test("runner: a restart invalidates the cache", async t => {
  const helper = fake(t);
  const s = new Screen({ helper });
  await s.context({ text: false });
  const pid = helper.pid();
  if (pid) process.kill(pid, "SIGKILL");
  await new Promise(r => setTimeout(r, 100));
  assert.equal((await s.context({ text: false })).cached, false);
});

test("runner: not built and not trusted come back as codes with words that say what to do", async t => {
  await assert.rejects(makeHelper({ bin: path.join(HERE, "no-such-helper"), platform: "darwin" }).request({ cmd: "where" }), e => e.code === "not_built" && /build\.sh/.test(e.message));
  const helper = fake(t, { notTrusted: true });
  await assert.rejects(helper.request({ cmd: "where" }), e => e.code === "not_trusted" && e.message === "grant Accessibility to Terminal in System Settings > Privacy & Security > Accessibility");
  await assert.rejects(makeHelper({ bin: FAKE, platform: "linux" }).request({ cmd: "where" }), e => e.code === "unsupported");
});

test("shot: without Screen Recording it says where to grant it, and asks macOS only when dialogs are allowed", async t => {
  const helper = fake(t);
  const shots = [];
  const s = new Screen({ helper, dialogs: () => false, responsible: () => "Terminal", capture: async a => { shots.push(a); } });
  await assert.rejects(s.shot(), e => e.code === "not_granted" && /Screen Recording/.test(e.message));
  assert.equal((await counts(helper)).requestCapture, undefined, "the permission dialog was requested under a test");
  assert.equal(shots.length, 0);
});

test("shot: blind places take no picture", async t => {
  const where = { app: { name: "Passwords", bundle: "com.apple.Passwords", pid: 5 }, window: { title: "All" } };
  const helper = fake(t, { where, granted: true });
  const shots = [];
  const r = /** @type {any} */ (await new Screen({ helper, capture: async a => { shots.push(a); } }).shot());
  assert.equal(r.blind, "a password manager");
  assert.equal(shots.length, 0);
  assert.equal((await counts(helper)).shotinfo, undefined);
});

test("shot: a full-screen shot is refused when a blind app is anywhere on screen", async t => {
  const helper = fake(t, { granted: true, windows: [{ pid: 4242, bundle: "com.apple.Notes" }, { pid: 5, bundle: "com.bitwarden.desktop", app: "Bitwarden" }] });
  const shots = [];
  const r = /** @type {any} */ (await new Screen({ helper, capture: async a => { shots.push(a); } }).shot({ window: false }));
  assert.equal(r.blind, "a password manager is on screen");
  assert.equal(shots.length, 0);
});

test("shot: a window PNG in a private folder that is deleted after its time", async t => {
  const helper = fake(t, { granted: true });
  const dir = tempHome(t);
  const png = Buffer.alloc(24); png.write("\x89PNG\r\n\x1a\n", 0, "latin1"); png.writeUInt32BE(13, 8); png.write("IHDR", 12); png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20);
  /** @type {string[][]} */
  const shots = [];
  const s = new Screen({ helper, shotDir: dir, shotTtlMs: 150, capture: async a => { shots.push(a); fs.writeFileSync(a[a.length - 1], png); } });
  t.after(() => s.stop());
  const r = /** @type {any} */ (await s.shot());
  assert.deepEqual(shots[0].slice(0, 3), ["-x", "-o", "-l7"]);
  assert.equal(r.width, 640); assert.equal(r.height, 480);
  assert.equal(fs.statSync(path.dirname(r.path)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(r.path).mode & 0o777, 0o600);
  await new Promise(res => setTimeout(res, 300));
  assert.equal(fs.existsSync(path.dirname(r.path)), false, "the screenshot outlived its time");
});
