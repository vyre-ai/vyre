// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { createDirectoryServer } from "./directory.js";

test("the self-hosted directory answers health and a name check, and keeps a state file path usable", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "dirsrv-"));
  const d = await createDirectoryServer({ stateFile: path.join(dir, "directory.state") });
  t.after(() => d.close());
  assert.equal((await fetch(`${d.url}/health`)).status, 200);
  const r = await (await fetch(`${d.url}/v1/names/check?name=roundtrip-test`)).json();
  assert.equal(r.data.status, "ok");
});

test("relay/Dockerfile is pinned by digest, runs as a non-root user and has a healthcheck", () => {
  const df = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(df, /^FROM node:[^\s@]+@sha256:[0-9a-f]{64}$/m);
  assert.match(df, /^USER node$/m);
  assert.match(df, /^HEALTHCHECK /m);
  assert.match(df, /^VOLUME \/data$/m);
});
