// @ts-check
// The one place under $TMPDIR every test in this checkout is allowed to make a directory.
// Scoped per checkout (hashed from this file's own path, which differs for every worktree), so
// tests running in one worktree can never see, or be blamed for, temp dirs made by tests running
// in a sibling worktree on the same shared machine. That happens constantly here: every worktree
// is a full copy of the same test suite, often mid-run at the same moment, so a leak-detector that
// scanned all of $TMPDIR would misattribute another worktree's (possibly still-unfixed) leaks to
// this one. The suite-level leak guard (test/tmp-guard.mjs) watches only this folder, before and
// after the whole run, for the same reason.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = crypto.createHash("sha256").update(REPO_ROOT).digest("hex").slice(0, 6);

// Kept deliberately short (not "vyre-test-root-<hash>"): a daemon's unix socket is a real file
// under a test's VYRE_HOME (see core/config/index.js socketPath, ~100-byte limit on macOS), and
// tests nest deep folder names under here already. Every extra byte here eats into that budget
// for every test that starts a real vyred; going over it switches those tests to a hashed
// fallback socket dir that a raw (non-realpath'd) VYRE_HOME and a realpath'd one hash
// differently, which silently breaks the client/daemon connection. Six hex characters is enough
// to keep worktrees apart and short enough to leave that budget alone.
/** Every test temp dir in this checkout lives under here, never bare in $TMPDIR. */
export const SCRATCH = path.join(os.tmpdir(), `vt-${KEY}`);
fs.mkdirSync(SCRATCH, { recursive: true });
