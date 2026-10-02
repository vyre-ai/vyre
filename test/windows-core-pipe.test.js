// The Windows app (local/capsule/native-win/src/core_pkg.rs) names vyred's pipe itself, so the name
// must be the one core/config/index.js `socketPath` makes on win32: vyre-<first 16 hex of
// sha256(real folder)>-<token from <home>\pipe-token>. The shared vector (tests/pipe-vector.json) is
// what the Rust side is tested against; this checks the vector and the real function agree.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { socketPath } from "../core/config/index.js";
import { tempHome } from "./helpers.js";

const vector = JSON.parse(fs.readFileSync(new URL("../local/capsule/native-win/tests/pipe-vector.json", import.meta.url), "utf8"));

test("windows core pipe: the shared vector follows the formula", () => {
  for (const c of vector.cases) {
    const hash = crypto.createHash("sha256").update(c.root).digest("hex").slice(0, 16);
    assert.equal(c.pipe, `\\\\.\\pipe\\vyre-${hash}-${c.token}`);
  }
});

test("windows core pipe: socketPath on win32 is that formula over the real folder and the pipe-token file", t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "pipe-token"), "0123456789abcdef0123456789abcdef");
  const real = fs.realpathSync(root);
  const hash = crypto.createHash("sha256").update(real).digest("hex").slice(0, 16);
  assert.equal(socketPath(root, { platform: "win32" }), `\\\\.\\pipe\\vyre-${hash}-0123456789abcdef0123456789abcdef`);
});
