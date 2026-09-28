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

// Windows socket (ADR 0037's LOW, security review): win32's socketPath is a literal named pipe
// name, never a filesystem path (a bound socket *file* would be an NTFS reparse point, which
// needs SeCreateSymbolicLinkPrivilege - proven missing on windows-latest CI, and unlikely on a
// real person's account either; a named pipe needs no privilege and gets a current-user-only
// security descriptor from Node by default). No folder, so nothing here to mkdir or ACL.

test("config: on win32, the socket is a named pipe, never a filesystem path", t => {
  const root = tempHome(t);
  const p1 = config.socketPath(root, { platform: "win32" });
  const p2 = config.socketPath(root + "y", { platform: "win32" });
  assert.match(p1, /^\\\\\.\\pipe\\vyre-/);
  assert.notEqual(p1, p2, "two homes never share a pipe name");
  assert.equal(p1, config.socketPath(root, { platform: "win32" }), "the same home always hashes to the same pipe name");
});

// Squatting (reviewer, ADR 0037's Windows LOW, section 7a point 2): the name is never derivable
// from `root` alone, so another local account cannot compute it just by guessing the home path.

test("config: the win32 pipe name is not derivable from root alone; two different processes reading the same home agree", t => {
  const root = tempHome(t);
  const name = config.socketPath(root, { platform: "win32" });
  const hashOnly = /^\\\\\.\\pipe\\vyre-[0-9a-f]{16}-/.exec(name);
  assert.ok(hashOnly, "the hash prefix is still there, for readability, not as the secret");
  const token = name.slice(hashOnly[0].length);
  assert.match(token, /^[0-9a-f]{32}$/, "a 16-byte random token, hex-encoded");
  // A "fresh process" is just a fresh call after the token file already exists on disk; nothing
  // here is cached in memory across the two socketPath calls beyond the token file itself.
  assert.equal(config.socketPath(root, { platform: "win32" }), name, "persisted, not re-rolled each call");
  assert.ok(fs.existsSync(path.join(root, "pipe-token")), "the token lives beside config.json, inside the home, never a shared folder");
});

test("config: two different homes never share a win32 pipe token, even with colliding hash prefixes forced", t => {
  const a = config.socketPath(tempHome(t), { platform: "win32" });
  const b = config.socketPath(tempHome(t), { platform: "win32" });
  const tokenOf = (/** @type {string} */ n) => n.slice(n.lastIndexOf("-") + 1);
  assert.notEqual(tokenOf(a), tokenOf(b));
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
