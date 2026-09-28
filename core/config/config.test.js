// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as config from "./index.js";
import { tempHome } from "../../test/helpers.js";

test("config: a fresh install has no config file and still loads", t => {
  const root = tempHome(t);
  const c = config.load(root);
  assert.deepEqual(c.problems, []);
  assert.ok(["box", "local"].includes(c.role));
});

test("config: user settings merge over defaults without dropping nested keys", t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", me: { domains: ["example.com"] } }));
  const c = config.load(root);
  assert.equal(c.role, "box");
  assert.deepEqual(c.me.domains, ["example.com"]);
  assert.deepEqual(c.me.emails, [], "a nested default vanished when the user set a sibling key");
});

test("config: a broken config file is reported, not fatal", t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), "{ not json");
  const c = config.load(root);
  assert.equal(c.problems.length, 1);
  assert.match(c.problems[0], /unreadable/);
});

test("config: an unknown role falls back and says so", t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "server" }));
  const c = config.load(root);
  assert.ok(["box", "local"].includes(c.role));
  assert.match(c.problems.join(" "), /role "server"/);
});

test("config: ensure creates private folders", t => {
  const root = tempHome(t);
  const p = config.ensure(root);
  for (const dir of [p.vault, p.modules, p.watchers, p.logs]) assert.ok(fs.statSync(dir).isDirectory());
  assert.equal(fs.statSync(p.vault).mode & 0o777, 0o700, "the vault folder is readable by other users");
});

test("config: a home too long for a unix socket puts the socket in a private per-user folder", t => {
  const root = path.join(tempHome(t), "x".repeat(120));
  const p = config.ensure(root);
  assert.ok(Buffer.byteLength(p.socket) <= 100, p.socket);
  assert.equal(p.socket, config.paths(root).socket, "the client and the daemon must agree on the path");
  assert.notEqual(config.paths(root + "y").socket, p.socket, "two homes never share a socket");
  const st = fs.statSync(path.dirname(p.socket));
  assert.equal(st.mode & 0o777, 0o700);
});

// Windows socket ACL (ADR 0037's LOW, security review): the socket never sits directly under an
// arbitrary VYRE_HOME on win32, and its folder's ACL is set with icacls, not chmod (which has no
// meaning there). These test the win32 branch by injecting platform/env/spawnSync, since none of
// this runs for real off Windows; the actual ACL is only proven by the windows-latest CI job.

test("config: on win32, the socket always lives under a per-user LOCALAPPDATA folder", t => {
  const root = tempHome(t);
  const p1 = config.socketPath(root, { platform: "win32" });
  const p2 = config.socketPath(root + "y", { platform: "win32" });
  assert.match(p1, /Vyre[\\/]sockets/);
  assert.notEqual(p1, p2, "two homes never share a socket");
  assert.equal(p1, config.socketPath(root, { platform: "win32" }), "the same home always hashes to the same socket");
});

test("config: ensureWindowsSocketDir strips inheritance then grants only the user (by SID) and SYSTEM", t => {
  const dir = path.join(tempHome(t), "sockets");
  const calls = [];
  const fakeSpawnSync = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "whoami") return { status: 0, stdout: '"HOST\\alex","S-1-5-21-1-2-3-1001"\r\n' };
    return { status: 0 };
  };
  const r = config.ensureWindowsSocketDir(dir, { env: { USERNAME: "alex" }, spawnSync: fakeSpawnSync });
  assert.equal(r, dir);
  assert.ok(fs.existsSync(dir));
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0], { cmd: "whoami", args: ["/user", "/fo", "csv", "/nh"] });
  assert.deepEqual(calls[1], { cmd: "icacls", args: [dir, "/inheritance:r"] });
  assert.deepEqual(calls[2], { cmd: "icacls", args: [dir, "/grant:r", "*S-1-5-21-1-2-3-1001:(OI)(CI)F"] });
  assert.deepEqual(calls[3], { cmd: "icacls", args: [dir, "/grant:r", "SYSTEM:(OI)(CI)F"] });
});

test("config: currentUserPrincipal falls back to the account name when whoami is missing, refuses or doesn't parse", t => {
  assert.equal(config.currentUserPrincipal({ env: { USERNAME: "alex" }, spawnSync: () => ({ error: new Error("ENOENT") }) }), "alex");
  assert.equal(config.currentUserPrincipal({ env: { USERNAME: "alex" }, spawnSync: () => ({ status: 1, stdout: "" }) }), "alex");
  assert.equal(config.currentUserPrincipal({ env: { USERNAME: "alex" }, spawnSync: () => ({ status: 0, stdout: "garbage, no csv here" }) }), "alex");
});

test("config: currentUserPrincipal prefers the live token's SID over the account name", t => {
  const spawnSync = () => ({ status: 0, stdout: '"HOST\\alex","S-1-5-21-1-2-3-1001"\r\n' });
  assert.equal(config.currentUserPrincipal({ env: { USERNAME: "alex" }, spawnSync }), "*S-1-5-21-1-2-3-1001");
});

test("config: ensureWindowsSocketDir throws, fail closed, when icacls is missing or refuses", t => {
  const dir = path.join(tempHome(t), "sockets");
  assert.throws(
    () => config.ensureWindowsSocketDir(dir, { env: { USERNAME: "alex" }, spawnSync: () => ({ error: new Error("ENOENT") }) }),
    /could not set an explicit ACL/,
  );
  assert.throws(
    () => config.ensureWindowsSocketDir(dir, { env: { USERNAME: "alex" }, spawnSync: () => ({ status: 1, stderr: "Access is denied." }) }),
    /could not set an explicit ACL/,
  );
});

test("config: the win32 socket's folder is the one ensureWindowsSocketDir would ACL", t => {
  // ensure() itself always uses the real process.platform (it must, off a test), so this checks
  // the pieces it composes rather than ensure() end to end for win32: socketPath's win32 folder
  // is exactly ensureWindowsSocketDir's default target, so ensure()'s
  // `ensureWindowsSocketDir(path.dirname(p.socket))` call ACLs the right directory.
  const root = tempHome(t);
  const socket = config.socketPath(root, { platform: "win32" });
  assert.equal(path.dirname(socket), path.dirname(config.socketPath(root + "y", { platform: "win32" })),
    "every home's win32 socket shares the same ACL'd parent folder, only the filename differs");
});

test("config: save merges one level deep, removes nulls and writes 0600", t => {
  const root = tempHome(t);
  config.save({ name: "alex", network: { owner: "alex@example.com", port: 8443 } }, root);
  config.save({ network: { port: null, address: "https://alex.vyre.run" } }, root);
  const c = config.load(root);
  assert.equal(c.name, "alex");
  assert.equal(c.network.owner, "alex@example.com");
  assert.equal(c.network.address, "https://alex.vyre.run");
  assert.equal(c.network.port, undefined);
  assert.equal(c.network.tailscale, false, "defaults are still merged under what was saved");
  assert.equal(fs.statSync(config.paths(root).config).mode & 0o777, 0o600);
  assert.ok(!("role" in JSON.parse(fs.readFileSync(config.paths(root).config, "utf8"))), "defaults were written to the file");
});

test("config: glass.egress is off with no sites by default, and survives a user's other glass keys", t => {
  const root = tempHome(t);
  assert.deepEqual(config.load(root).glass.egress, { enabled: false, sites: [] });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ glass: { roots: ["/work"] } }));
  const c = config.load(root);
  assert.deepEqual(c.glass.roots, ["/work"]);
  assert.deepEqual(c.glass.egress, { enabled: false, sites: [] }, "a user's glass.roots dropped the egress default");
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ glass: { egress: { enabled: true } } }));
  assert.deepEqual(config.load(root).glass.egress, { enabled: true, sites: [] });
});

test("config: computers.tailnet is off by default, and survives a user's other computers keys", t => {
  const root = tempHome(t);
  assert.deepEqual(config.load(root).computers.tailnet, { enabled: false, tag: "tag:vyre-agent" });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ computers: { docker: "http://docker-api:2375" } }));
  const c = config.load(root);
  assert.equal(c.computers.docker, "http://docker-api:2375");
  assert.deepEqual(c.computers.tailnet, { enabled: false, tag: "tag:vyre-agent" }, "a user's computers.docker dropped the tailnet default");
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ computers: { tailnet: { enabled: true } } }));
  assert.deepEqual(config.load(root).computers.tailnet, { enabled: true, tag: "tag:vyre-agent" });
});

/** Run fn with env vars set, putting them back after. */
function withEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return fn(); } finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test("config: a new box with a work folder keeps projects in it; an existing one only once its homes moved; a Mac never", t => {
  const root = tempHome(t);
  const work = path.join(root, "work");
  const oldDir = path.join(root, "home", "Vyre", "projects");
  const old = path.join(os.homedir(), "Vyre", "projects");
  const set = obj => fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(obj));
  withEnv({ VYRE_WORK_DIR: work, VYRE_OLD_PROJECTS_DIR: oldDir }, () => {
    set({ role: "box" });
    assert.equal(config.load(root).projectsDir, old, "no work folder yet");
    fs.mkdirSync(work);
    assert.equal(config.load(root).projectsDir, path.join(work, "projects"), "a new box: no old folder");
    fs.mkdirSync(oldDir, { recursive: true });
    assert.equal(config.load(root).projectsDir, path.join(work, "projects"), "a new box: an empty old folder");
    fs.mkdirSync(path.join(oldDir, "harlow-legal"));
    assert.equal(config.load(root).projectsDir, old, "an existing box keeps its folder until projects.move runs");
    fs.writeFileSync(path.join(root, config.MOVED_RECORD), "{}\n");
    assert.equal(config.load(root).projectsDir, path.join(work, "projects"), "moved: the work folder");
    assert.equal(config.boxProjectsDir(), path.join(work, "projects"));
    set({ role: "local" });
    assert.equal(config.load(root).projectsDir, old, "a Mac never uses the work folder");
    set({ role: "box", projectsDir: "~/Elsewhere" });
    assert.equal(config.load(root).projectsDir, path.join(os.homedir(), "Elsewhere"), "the user's projectsDir wins");
  });
});
