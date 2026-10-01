// @ts-check
// LIVE, opt-in only: the sign-in against the REAL GitHub CLI binary (the one pinned in
// box/Dockerfile, 2.102.0), on a GitHub Actions runner only (VYRE_LIVE_GITHUB=1), never on the Mac.
// No GitHub account anywhere: gh asks GitHub for a device code anonymously, prints it, and the test
// cancels the sign-in at once, so nothing is ever approved. It proves what the fake gh cannot: that
// the pinned gh still prints the code and address in the shape connect.js parses, that the flags
// connect.js passes are accepted, and that cancelling stops gh and removes its private folder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connector, resolveGh } from "./connect.js";

const LIVE = process.env.VYRE_LIVE_GITHUB === "1";
const skip = LIVE ? false : "set VYRE_LIVE_GITHUB=1 to run this on a GitHub Actions runner (real gh, real network, no account)";

test("LIVE: the pinned gh prints the sign-in code and address connect.js parses, accepts every flag, and cancel stops it and removes its folder", { skip }, async t => {
  // The runner image ships its own gh in /usr/bin; the workflow installs the pinned one in /usr/local/bin
  // and names it, so the test proves the version Vyre ships and not whichever gh comes first.
  const gh = resolveGh(process.env.VYRE_GH_BIN || undefined);
  assert.ok(gh, "gh is installed on the runner");
  const version = /gh version (\d+\.\d+\.\d+)/.exec(spawnSync(gh, ["--version"], { encoding: "utf8" }).stdout || "");
  const pinned = /ARG GH_VERSION=(\S+)/.exec(fs.readFileSync(new URL("../../box/Dockerfile", import.meta.url), "utf8"));
  assert.ok(version && pinned && version[1] === pinned[1], `the gh on this runner (${version && version[1]}) is the pinned one (${pinned && pinned[1]})`);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-gh-live-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const events = [];
  const c = connector({ gh, tmpRoot, taken: () => false, save: async () => { throw new Error("nothing is saved"); }, add: async () => { throw new Error("nothing is added"); },
    emit: (type, payload) => events.push({ type, payload }), codeWaitMs: 60_000 });
  t.after(() => c.stop());
  const started = await c.start({ name: "live" });
  assert.match(started.user_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(started.verification_uri, "https://github.com/login/device");
  assert.equal(c.status(started.id), "pending");
  assert.equal(fs.readdirSync(tmpRoot).length, 1, "gh works in its one private folder");
  assert.deepEqual(await c.cancel({ id: started.id }), { cancelled: true });
  assert.deepEqual(fs.readdirSync(tmpRoot), [], "cancel removes the folder");
  assert.equal(events.some(e => e.type === "github.connected"), false, "nothing was ever approved");
});
