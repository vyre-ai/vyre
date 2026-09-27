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

test("config: a box with a work folder keeps projects in it; without one, or on a Mac, ~/Vyre/projects", t => {
  const root = tempHome(t);
  const work = path.join(root, "work");
  const old = path.join(os.homedir(), "Vyre", "projects");
  const set = obj => fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(obj));
  withEnv({ VYRE_WORK_DIR: work }, () => {
    set({ role: "box" });
    assert.equal(config.load(root).projectsDir, old, "no work folder yet");
    fs.mkdirSync(work);
    assert.equal(config.load(root).projectsDir, path.join(work, "projects"));
    assert.equal(config.boxProjectsDir(), path.join(work, "projects"));
    set({ role: "local" });
    assert.equal(config.load(root).projectsDir, old, "a Mac never uses the work folder");
    set({ role: "box", projectsDir: "~/Elsewhere" });
    assert.equal(config.load(root).projectsDir, path.join(os.homedir(), "Elsewhere"), "the user's projectsDir wins");
  });
});
