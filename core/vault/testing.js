// @ts-check
// testing — a temporary macOS keychain for tests, safe when many test runs share one machine.
//
// A test must never touch the user's login keychain, so keychain tests make their own. The first
// version compared the user's whole keychain search list before and after and wrote it back if it
// differed. With a dozen worktrees testing at once that is wrong twice over: another run changes
// the list in between (a false failure), and writing the old list back undoes that run's change.
// So this never writes the list back. It only removes its own keychain from it, if it appears,
// and test keychains a crashed run left listed after their files were deleted. `create-keychain`
// always adds to the list, so the read-modify-write of the list is held under a lock shared by
// every test process on the machine; without it two runs can each write back the other's entry.
// Every name and path is unique to one test, `security` calls are retried when the keychain
// daemon is busy, and cleanup is registered before anything is created, so it runs on failure.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { open, migrate } from "../store/index.js";
import { SCRATCH } from "../../test/scratch.mjs";

const wait = ms => new Promise(r => setTimeout(r, ms));

/** Run `security`, retrying a few times when it fails for a reason other than "not found". */
export async function securityRetry(args, { tries = 5, ok = [0] } = {}) {
  let last = { code: -1, out: "", err: "" };
  for (let i = 0; i < tries; i++) {
    last = await new Promise(resolve => execFile("security", args, { encoding: "utf8" }, (e, out, err) =>
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out, err })));
    if (ok.includes(last.code)) return last;
    await wait(100 * 2 ** i + Math.floor(Math.random() * 100));
  }
  throw new Error(`security ${args[0]} failed after ${tries} tries: ${last.err.trim() || "exit " + last.code}`);
}

/** The user's keychain search list, as paths. */
async function searchList() {
  const r = await securityRetry(["list-keychains", "-d", "user"]);
  return r.out.split("\n").map(l => l.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

/**
 * A fresh, unlocked keychain that never auto-locks, deleted after the test.
 * @param {import("node:test").TestContext} t
 * @returns {Promise<string>} the keychain file's path
 */
export async function tempKeychain(t) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-kc-"));
  const file = path.join(dir, `vyre-test-${process.pid}-${crypto.randomBytes(6).toString("hex")}.keychain-db`);
  const pw = crypto.randomBytes(16).toString("hex");
  t.after(async () => {
    await withListLock(async () => {
      try { await securityRetry(["delete-keychain", file], { tries: 3 }); } catch {}
      try { await dropFromSearchList(file); } catch {}
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await withListLock(async () => {
    await securityRetry(["create-keychain", "-p", pw, file]);
    await dropFromSearchList(file);
  });
  await securityRetry(["unlock-keychain", "-p", pw, file]);
  // No timeout and no lock on sleep: a slow, busy machine must not lock it mid-test.
  await securityRetry(["set-keychain-settings", file]);
  return file;
}

const LOCK = path.join(os.tmpdir(), "vyre-test-keychain-list.lock");
const STALE_MS = 30_000;

/**
 * Run `fn` holding a machine-wide lock (a directory, since mkdir is atomic). A lock older than
 * STALE_MS belongs to a run that died holding it and is taken over.
 * @template T @param {() => Promise<T>} fn @returns {Promise<T>}
 */
async function withListLock(fn) {
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(LOCK); break; } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > STALE_MS) fs.rmSync(LOCK, { recursive: true, force: true }); } catch {}
      if (i > 600) throw new Error(`timed out waiting for ${LOCK}`);
      await wait(25 + Math.floor(Math.random() * 50));
    }
  }
  try { return await fn(); } finally { fs.rmSync(LOCK, { recursive: true, force: true }); }
}

const TEST_KEYCHAIN = /\/vyre-test-[^/]*\.keychain-db$/;

/**
 * Remove this keychain from the search list, and any test keychain whose file is gone, leaving
 * every other entry as it is. Call under withListLock.
 */
async function dropFromSearchList(file) {
  const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
  const list = await searchList();
  const rest = list.filter(p => real(p) !== real(file) && !(TEST_KEYCHAIN.test(p) && !fs.existsSync(p)));
  if (rest.length !== list.length) await securityRetry(["list-keychains", "-d", "user", "-s", ...rest]);
}

/** Whether a keychain file is on the user's search list (it never should be). */
export async function onSearchList(file) {
  const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
  return (await searchList()).some(p => real(p) === real(file));
}

/** Start the vault module against a ctx that records every tool definition. */
export async function recorded(t, extra = {}) {
  const tmp = fs.mkdtempSync(path.join(SCRATCH, "vyre-presence-"));
  const db = open(path.join(tmp, "vyre.db"));
  /** @type {Map<string, any>} */
  const tools = new Map();
  const events = [], logs = [];
  const ctx = {
    store: { db, migrate: steps => migrate(db, "vault", steps) },
    paths: { vault: path.join(tmp, "vault") },
    config: { name: "test-box", vault: { keystore: "file", ...extra } },
    events: { emit: (type, p) => events.push({ type, p }) },
    log: m => logs.push(m),
    tool: (name, def) => tools.set(name, def),
  };
  const mod = (await import("./index.js")).default;
  const running = await mod.start(ctx);
  t.after(async () => { await running.stop(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const run = (name, input, caller = "cli") => tools.get(name).run(input, { caller });
  return { tmp, db, tools, events, logs, run };
}

