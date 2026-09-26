// @ts-check
// The Mattermost compose fragment, checked as text. There is no Docker on the machines that run
// this suite and no YAML parser in the dependencies, so these are the promises that matter,
// read straight off the file: every image pinned, no password written down, Mattermost on
// loopback only, the shared network, and the one allowance that lets buttons reach vyred.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "compose.yml");
const text = fs.readFileSync(FILE, "utf8");
/** The file without comment lines, so a comment cannot satisfy or break a check. */
const body = text.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");

test("compose: every image is pinned to a version, never latest", () => {
  const images = [...body.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map(m => m[1]);
  assert.ok(images.some(i => i.startsWith("mattermost/mattermost-team-edition:")), "mattermost image present");
  assert.ok(images.some(i => i.startsWith("postgres:16")), "postgres 16 image present");
  for (const i of images) {
    const tag = i.split(":")[1] || "";
    assert.match(tag, /^\d+\.\d+(\.\d+)?(-[a-z0-9]+)?$/, `${i} is pinned to a version`);
    assert.doesNotMatch(i, /latest/);
  }
});

test("compose: no password is written down; it comes from the environment", () => {
  const secrets = [...body.matchAll(/^\s*(POSTGRES_PASSWORD|MM_SQLSETTINGS_DATASOURCE):\s*(.+)$/gm)];
  assert.equal(secrets.length, 2);
  for (const [, key, value] of secrets) assert.match(value, /\$\{VYRE_CHAT_DB_PASSWORD:\?/, `${key} reads the required env var`);
  assert.doesNotMatch(body.replace(/\$\{[^}]*\}/g, ""), /postgres:\/\/[^:@\s]+:[^@\s]+@/, "no literal credential in a URL");
});

test("compose: Mattermost is published on loopback only", () => {
  const ports = [...body.matchAll(/^\s*-\s*"?([^"\s]+:\d+(?::\d+)?)"?\s*$/gm)].map(m => m[1]).filter(p => /:\d+$/.test(p) && /^\d|^\[/.test(p));
  assert.deepEqual(ports, ["127.0.0.1:8065:8065"]);
  assert.doesNotMatch(body, /0\.0\.0\.0:\d+/);
});

test("compose: both services are on the vyre network", () => {
  assert.match(body, /^networks:\s*\n\s+vyre:\s*\n\s+name:\s*vyre\s*$/m);
  assert.equal([...body.matchAll(/^\s*networks:\s*\[vyre\]\s*$/gm)].length, 2);
});

test("compose: Mattermost may call vyred, and only vyred, on the internal network", () => {
  assert.match(body, /MM_SERVICESETTINGS_ALLOWEDUNTRUSTEDINTERNALCONNECTIONS:\s*"vyred"/);
});
