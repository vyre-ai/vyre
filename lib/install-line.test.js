// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInstallLine, installCommandWithCode } from "./install-line.js";
import { commandOk } from "./first-run-shape.js";

test("stable install lines use vyre.run/i for linux and mac", () => {
  const code = "A".repeat(239);
  const line = installCommandWithCode(code);
  assert.equal(line, buildInstallLine({ code }));
  assert.equal(line, buildInstallLine({ code, os: "mac" }));
  assert.match(line, /^curl -fsSL vyre\.run\/i \| VYRE_CODE=/);
  assert.ok(commandOk(line));
});

test("release candidates pin their own script URL", () => {
  const code = "B".repeat(239);
  const v = "0.3.0-rc.1";
  const base = `https://github.com/vyre-ai/vyre/releases/download/v${v}/`;
  assert.equal(buildInstallLine({ version: v, code, os: "linux" }), `curl -fsSL ${base}install-box.sh | VYRE_BOX_URL=${base} VYRE_CODE=${code} VYRE_STORE=auto sh`);
  assert.equal(buildInstallLine({ version: v, code, os: "mac" }), `curl -fsSL ${base}install-mac-server.sh | VYRE_BOX_URL=${base} VYRE_CODE=${code} VYRE_STORE=auto sh`);
});
