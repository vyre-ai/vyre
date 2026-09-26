// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
