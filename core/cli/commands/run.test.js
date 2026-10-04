// @ts-check
// `vyre run`: the arguments it hands to vault run, and ./.env picked up only when it holds refs.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../../test/scratch.mjs";
import { runArgs } from "./run.js";

test("vyre run: adds --, reads ./.env only when it holds vault references and nothing was named", t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-run-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // No .env: the command is passed through, with a -- when there was none.
  assert.deepEqual(runArgs(["npm", "start"], dir), ["run", "--", "npm", "start"]);
  assert.deepEqual(runArgs(["--", "npm", "start"], dir), ["run", "--", "npm", "start"]);
  // A plain .env is the program's business.
  fs.writeFileSync(path.join(dir, ".env"), "PORT=3000\n");
  assert.deepEqual(runArgs(["--", "npm", "start"], dir), ["run", "--", "npm", "start"]);
  // One with references is read.
  fs.writeFileSync(path.join(dir, ".env"), "PORT=3000\nexport STRIPE_SECRET_KEY=vault://northwind.env/STRIPE_SECRET_KEY\n");
  assert.deepEqual(runArgs(["--", "npm", "start"], dir), ["run", "--env-file", path.join(dir, ".env"), "--", "npm", "start"]);
  fs.writeFileSync(path.join(dir, ".env"), 'DSN="postgres://kit:{{ vault://harlow-db/password }}@db.harlow.test/app"\n');
  assert.deepEqual(runArgs(["node", "app.js"], dir), ["run", "--env-file", path.join(dir, ".env"), "--", "node", "app.js"]);
  // Items or an --env-file named: ./.env is not added.
  assert.deepEqual(runArgs(["TOKEN=kit-token.value", "--", "node", "x"], dir), ["run", "TOKEN=kit-token.value", "--", "node", "x"]);
  assert.deepEqual(runArgs(["--env-file", "other.env", "--", "node", "x"], dir), ["run", "--env-file", "other.env", "--", "node", "x"]);
});
