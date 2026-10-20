// @ts-check
// A box's agent computers work with no config.json edit: on a box (VYRE_SUPERVISOR=docker) the computers driver is the docker-api proxy, with exactly
// the create policy compose hands the proxy, and each agent its own Linux user. config.json wins, and can turn computers off.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { BOX_PROXY_URL, PROXY_DEFAULTS, computersFromEnv, effectiveComputers } from "./computers-env.js";

const BOX = { VYRE_SUPERVISOR: "docker", VYRE_COMPUTERS_IMAGE: "ghcr.io/vyre-ai/vyre-computer@sha256:" + "5".repeat(64), VYRE_COMPUTERS_NETWORK: "vyre-computers", VYRE_COMPUTERS_LABEL_PREFIX: "run.vyre.computers", VYRE_COMPUTERS_CAP_ADD: "" };

test("a box with no computers setting uses the docker-api proxy with the proxy's own image, network and label prefix, and an agent user each", () => {
  for (const cfg of [undefined, {}, { handbackIdleMin: 5 }]) {
    const c = effectiveComputers(cfg, BOX);
    assert.equal(c.docker, BOX_PROXY_URL);
    assert.equal(c.image, BOX.VYRE_COMPUTERS_IMAGE);
    assert.equal(c.network, "vyre-computers");
    assert.equal(c.labelPrefix, "run.vyre.computers");
    assert.equal(c.agentUsers, true);
    assert.equal(c.capAdd, undefined, "no extra capability unless the box names one");
  }
  assert.equal(effectiveComputers({ handbackIdleMin: 5 }, BOX).handbackIdleMin, 5, "other settings are kept");
});

test("with no VYRE_COMPUTERS_* in the environment, a box falls back to the proxy's defaults, not the pool's", () => {
  const c = effectiveComputers({}, { VYRE_SUPERVISOR: "docker" });
  assert.deepEqual([c.docker, c.image, c.network, c.labelPrefix], [BOX_PROXY_URL, PROXY_DEFAULTS.image, PROXY_DEFAULTS.network, PROXY_DEFAULTS.labelPrefix]);
  assert.deepEqual(computersFromEnv({}), { ...PROXY_DEFAULTS, capAdd: [] });
  assert.deepEqual(computersFromEnv({ VYRE_COMPUTERS_CAP_ADD: " NET_ADMIN , SYS_PTRACE," }).capAdd, ["NET_ADMIN", "SYS_PTRACE"]);
});

test("config.json wins: an explicit driver, image or agentUsers is kept as it is", () => {
  assert.deepEqual(effectiveComputers({ driver: "fake" }, BOX), { driver: "fake" });
  const own = effectiveComputers({ docker: "http://proxy:9", image: "mine:1", agentUsers: false }, BOX);
  assert.deepEqual([own.docker, own.image, own.agentUsers, own.network, own.labelPrefix], ["http://proxy:9", "mine:1", false, "vyre-computers", "run.vyre.computers"]);
});

test("config.json can turn a box's computers off", () => {
  for (const off of [{ enabled: false }, { driver: "none" }, { docker: false }]) {
    const c = effectiveComputers(off, BOX);
    assert.equal(c.docker, undefined, JSON.stringify(off));
    assert.equal(c.driver, undefined, JSON.stringify(off));
  }
});

test("off a box nothing is implied: no driver unless config names one", () => {
  for (const env of [{}, { VYRE_SUPERVISOR: "systemd" }, { VYRE_SUPERVISOR: "launchd", VYRE_COMPUTERS_IMAGE: "x" }]) {
    assert.deepEqual(effectiveComputers({}, env), {});
    assert.deepEqual(effectiveComputers({ docker: "http://p:1" }, env), { docker: "http://p:1" });
  }
});

test("box/compose.yml hands vyred and the docker-api proxy the same create policy, from one anchored line each", () => {
  const compose = fs.readFileSync(path.resolve(import.meta.dirname, "../box/compose.yml"), "utf8");
  const code = compose.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
  const names = ["computers-network", "computers-image", "computers-label-prefix", "computers-cap-add"];
  for (const n of names) assert.equal([...code.matchAll(new RegExp(`&${n}\\b`, "g"))].length, 1, `one anchor ${n}`);
  const block = (/** @type {string} */ svc) => {
    const start = code.indexOf(`\n  ${svc}:\n`);
    assert.ok(start >= 0, svc);
    const rest = code.slice(start + 1);
    const end = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n|\n[a-z]/);
    return end < 0 ? rest : rest.slice(0, end + 1);
  };
  for (const svc of ["vyre", "docker-api"]) for (const n of names) assert.match(block(svc), new RegExp(`^\\s+- \\*${n}$`, "m"), `${svc} gets *${n}`);
  // The released compose.yml pins the computers image's default on that one line; every check (box/vyre, install-box.sh, check-release-dist) reads every default.
  assert.equal([...code.matchAll(/VYRE_COMPUTERS_IMAGE:-([^}\s]*)\}/g)].length, 1, "one default of VYRE_COMPUTERS_IMAGE");
  // The anchors' defaults are the proxy's (lib/computers-env.js PROXY_DEFAULTS), so a box with nothing set agrees on both sides.
  assert.match(code, /VYRE_COMPUTERS_NETWORK=\$\{VYRE_COMPUTERS_NETWORK:-vyre-computers\}/);
  assert.match(code, /VYRE_COMPUTERS_IMAGE=\$\{VYRE_COMPUTERS_IMAGE:-vyre\/computer:0\.1\}/);
  assert.match(code, /VYRE_COMPUTERS_LABEL_PREFIX=\$\{VYRE_COMPUTERS_LABEL_PREFIX:-run\.vyre\.computers\}/);
  assert.match(block("vyre"), /^\s+- VYRE_SUPERVISOR=docker$/m, "and vyred knows it is on a box");
});
