// @ts-check
// The native messaging installer for macOS, Linux and Windows, against a temp home, a temp host
// folder and a fake registry: nothing here touches a real browser directory or the registry.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { install, uninstall, status, extensionIdFromKey, extensionIdFromPath } from "./native-host/install.js";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const rig = (/** @type {any} */ t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vc-i-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hostDir = path.join(home, "host");
  fs.mkdirSync(hostDir);
  fs.writeFileSync(path.join(hostDir, "run-host.sh"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(hostDir, "run-host.cmd"), "@echo off\r\n");
  /** @type {Record<string, string>} */
  const keys = {};
  const registry = (/** @type {string} */ k, /** @type {string|null|undefined} */ v) => { if (v === undefined) return keys[k] ?? null; if (v === null) delete keys[k]; else keys[k] = v; return v; };
  return { home, hostDir, keys, registry };
};

test("ids: 32 letters a to p, stable, and derived from the key or from the path", () => {
  const key = Buffer.from("not a real key but bytes are bytes").toString("base64");
  const a = extensionIdFromKey(key);
  assert.match(a, /^[a-p]{32}$/);
  assert.equal(a, extensionIdFromKey(key));
  assert.notEqual(a, extensionIdFromKey(Buffer.from("another").toString("base64")));
  const p = extensionIdFromPath("/Users/alex/vyre/extension");
  assert.match(p, /^[a-p]{32}$/);
  assert.notEqual(p, extensionIdFromPath("/Users/alex/vyre/extension2"));
  assert.notEqual(extensionIdFromPath("C:\\vyre\\ext", "win32"), extensionIdFromPath("C:\\vyre\\ext", "linux"), "Windows hashes the UTF-16 path");
});

test("install on macOS: the manifest goes in each browser's own folder, pins the extension and names the launcher", t => {
  const { home, hostDir } = rig(t);
  const r = install({ home, platform: "darwin", extensionId: ID, hostDir, browsers: ["chrome", "chromium", "brave", "edge"] });
  const at = (/** @type {string} */ ...p) => path.join(home, "Library", "Application Support", ...p, "NativeMessagingHosts", "run.vyre.chrome.json");
  for (const f of [at("Google", "Chrome"), at("Chromium"), at("BraveSoftware", "Brave-Browser"), at("Microsoft Edge")]) {
    const m = JSON.parse(fs.readFileSync(f, "utf8"));
    assert.deepEqual(m, { name: "run.vyre.chrome", description: m.description, path: path.join(hostDir, "run-host.sh"), type: "stdio", allowed_origins: [`chrome-extension://${ID}/`] });
    assert.ok(path.isAbsolute(m.path));
  }
  assert.equal(r.written.length, 4);
  assert.equal(fs.readFileSync(path.join(hostDir, "node-path"), "utf8"), process.execPath);
  assert.ok(fs.statSync(path.join(hostDir, "run-host.sh")).mode & 0o100, "the launcher is executable");
});

test("install on Linux: ~/.config per browser", t => {
  const { home, hostDir } = rig(t);
  install({ home, platform: "linux", extensionId: ID, hostDir, browsers: ["chrome", "chromium", "brave", "edge"] });
  for (const d of ["google-chrome", "chromium", "BraveSoftware/Brave-Browser", "microsoft-edge"]) {
    assert.ok(fs.existsSync(path.join(home, ".config", d, "NativeMessagingHosts", "run.vyre.chrome.json")), d);
  }
});

test("install without a browser list: Chrome always, others only if their folder exists", t => {
  const { home, hostDir } = rig(t);
  fs.mkdirSync(path.join(home, ".config", "chromium"), { recursive: true });
  const r = install({ home, platform: "linux", extensionId: ID, hostDir });
  assert.deepEqual(r.written.map(w => w.browser).sort(), ["chrome", "chromium"]);
});

test("install on Windows: the manifest sits under the Vyre home and the registry points at it, per browser", t => {
  const { home, hostDir, keys, registry } = rig(t);
  const vyreHome = path.join(home, "vyre-home");
  const r = install({ home, vyreHome, platform: "win32", extensionId: ID, hostDir, registry, browsers: ["chrome", "edge", "brave"] });
  const file = path.join(vyreHome, "chrome", "run.vyre.chrome.json");
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(m.path, path.join(hostDir, "run-host.cmd"));
  assert.deepEqual(Object.keys(keys).sort(), [
    "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\run.vyre.chrome",
    "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\run.vyre.chrome",
    "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\run.vyre.chrome",
  ]);
  for (const v of Object.values(keys)) assert.equal(v, file);
  assert.equal(r.written.length, 3);
});

test("install refuses an id that is not an extension id, and a missing launcher", t => {
  const { home, hostDir } = rig(t);
  assert.throws(() => install({ home, platform: "darwin", extensionId: "nope", hostDir }), /not a Chrome extension id/);
  assert.throws(() => install({ home, platform: "darwin", extensionId: ID, hostDir: path.join(home, "empty") }), /launcher is missing/);
});

test("status and uninstall on macOS", t => {
  const { home, hostDir } = rig(t);
  let s = status({ home, platform: "darwin", hostDir });
  assert.deepEqual(s.installed, []);
  assert.equal(s.launcherExists, true);
  install({ home, platform: "darwin", extensionId: ID, hostDir, browsers: ["chrome", "brave"] });
  s = status({ home, platform: "darwin", hostDir });
  assert.deepEqual(s.installed.map(x => x.browser).sort(), ["brave", "chrome"]);
  assert.ok(s.installed.every(x => x.extensionId === ID && x.pointsAtLauncher));
  assert.equal(s.launcherExecutable, true);
  assert.equal(s.nodePath, process.execPath);
  const u = uninstall({ home, platform: "darwin", browsers: ["chrome"] });
  assert.equal(u.removed.length, 1);
  assert.deepEqual(status({ home, platform: "darwin", hostDir }).installed.map(x => x.browser), ["brave"]);
  uninstall({ home, platform: "darwin" });
  assert.deepEqual(status({ home, platform: "darwin", hostDir }).installed, []);
});

test("status says the launcher is not executable when it is not", { skip: process.platform === "win32" }, t => {
  const { home, hostDir } = rig(t);
  fs.chmodSync(path.join(hostDir, "run-host.sh"), 0o644);
  assert.equal(status({ home, platform: "darwin", hostDir }).launcherExecutable, false);
});

test("status and uninstall on Windows read and delete the registry keys", t => {
  const { home, hostDir, keys, registry } = rig(t);
  const vyreHome = path.join(home, "v");
  install({ home, vyreHome, platform: "win32", extensionId: ID, hostDir, registry, browsers: ["chrome", "edge"] });
  const s = status({ home, vyreHome, platform: "win32", hostDir, registry });
  assert.deepEqual(s.installed.map(x => x.browser).sort(), ["chrome", "edge"]);
  assert.ok(s.launcherExists);
  uninstall({ home, vyreHome, platform: "win32", registry });
  assert.deepEqual(keys, {});
  assert.equal(fs.existsSync(path.join(vyreHome, "chrome", "run.vyre.chrome.json")), false);
});

test("Dia and Arc: registered on macOS under their own \"User Data\" folder when they are installed, listed by status, removed by uninstall; not a Linux or Windows browser here", t => {
  const { home, hostDir } = rig(t);
  const dia = path.join(home, "Library", "Application Support", "Dia", "User Data");
  fs.mkdirSync(dia, { recursive: true });
  // No Arc folder: detection registers Chrome and Dia only.
  const r = install({ home, platform: "darwin", extensionId: ID, hostDir });
  assert.deepEqual(r.written.map(w => w.browser).sort(), ["chrome", "dia"]);
  const f = path.join(dia, "NativeMessagingHosts", "run.vyre.chrome.json");
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).allowed_origins[0], `chrome-extension://${ID}/`);
  assert.deepEqual(status({ home, platform: "darwin", hostDir }).installed.map(x => x.browser).sort(), ["chrome", "dia"]);
  // Asked for by name, Arc is registered even without a folder yet (the person is about to install it).
  const a = install({ home, platform: "darwin", extensionId: ID, hostDir, browsers: ["arc"] });
  assert.deepEqual(a.written.map(w => w.browser), ["arc"]);
  assert.ok(fs.existsSync(path.join(home, "Library", "Application Support", "Arc", "User Data", "NativeMessagingHosts", "run.vyre.chrome.json")));
  // On Linux they have no known place: skipped and said so, never an error or a wrong folder.
  const l = install({ home, platform: "linux", extensionId: ID, hostDir, browsers: ["chrome", "dia", "arc"] });
  assert.deepEqual(l.written.map(w => w.browser), ["chrome"]);
  assert.deepEqual(l.skipped, ["dia", "arc"]);
  const u = uninstall({ home, platform: "darwin" });
  assert.ok(u.removed.some(x => x.browser === "dia") && u.removed.some(x => x.browser === "arc"));
  assert.equal(fs.existsSync(f), false);
});
