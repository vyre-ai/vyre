// @ts-check
// Shared by core/sessions/sessions.test.js and sessions-turns.test.js (split 2026-09-28: one
// file, ~80 real subprocess-spawning tests across both drivers, sat right at the edge of the
// full suite's 90s file timeout under concurrency-4 contention - splitting parallelizes it
// instead of raising the ceiling). Nothing here is a test itself; both files import it.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { start } from "../../daemon/index.js";
import { call } from "../../daemon/client.js";
import { tempHome, present, writeModule } from "../../../test/helpers.js";
import { SCRATCH } from "../../../test/scratch.mjs";
import { installed } from "../sdk.js";

// This file lives at core/sessions/testing/, one level under where sessions.test.js used to
// resolve these from - the paths below account for that (unchanged targets: core/sessions/
// testing/fake-tini.js, core/switchboard/testing/fake-claude.js).
export const TINI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fake-tini.js");
fs.chmodSync(TINI, 0o755);

export const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "switchboard", "testing", "fake-claude.js");
fs.chmodSync(FAKE, 0o755);
export const SDK = process.env.VYRE_SESSIONS_SDK_DIR || "";
export const noSdk = !SDK || !installed(SDK) ? "the Agent SDK is not installed here (set VYRE_SESSIONS_SDK_DIR)" : false;

// A development build opts out of the session sandbox (daemon/index.js, VYRE_SESSION_SANDBOX_OFF): with the kernel on a session is confined by bwrap, which hides the fake claude's log and transcript folders in the temp home. The sandbox has its own tests.
process.env.VYRE_SESSION_SANDBOX_OFF = "1";

export const until = async (fn, what, ms = 15_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 40));
  }
};

/**
 * A vyred in a temp home, on `driver`. `sessions` is config.json's sessions block; `vault` items
 * are put and granted to module threads (the box's own credential) unless `grant` is false.
 */
export async function boot(t, { driver = "cli", sessions = {}, vault = {}, role = "box", modules = [] } = {}) {
  // tempHome's own cleanup always runs first (after-hooks run in the order they were added), so
  // it needs a way to stop this in-process vyred before it removes the directory - otherwise the
  // directory comes out from under a daemon (and any live child) still writing to it. `daemon` is
  // set below once start() resolves; stop() closing over it (rather than passing d.stop directly,
  // which does not exist yet at this point) is what makes the ordering work.
  let daemon = null;
  const root = tempHome(t, { stop: () => daemon && daemon.stop() });
  const log = path.join(root, "claude.log");
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG,
    VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, VYRE_SESSIONS_SDK_DIR: process.env.VYRE_SESSIONS_SDK_DIR, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log, VYRE_SESSIONS_DRIVER: driver, FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  if (SDK) process.env.VYRE_SESSIONS_SDK_DIR = SDK;
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role, transcripts: [transcripts],
    // claude "installed": these suites run the fake claude (VYRE_CLAUDE_BIN), so the SDK needs
    // only its JS, never the bundled binary a box's default asks for (CI installs --omit=optional).
    sessions: { install: false, ...(driver === "sdk" ? { claude: "installed" } : {}), ...sessions }, ...(Object.keys(vault).length ? { vault: { keystore: "file" } } : {}) }));
  // Internal tools answer only modules, and a module in a temp home is an added one (contract v1
  // keeps those out of internal tools). `internal` calls as vyred's own module label, which the
  // loader treats as Vyre's, the way a first-party module would.
  for (const m of modules) writeModule(path.join(root, "modules"), m.name, m.manifest, m.source);
  // The probe and any modules given here stand in for Vyre's own (internal tools, session
  // providers), so the home's modules folder loads as first party (ADR 0047). Test only.
  const d = await start({ root, presence: present, log: () => {}, firstPartyRoots: [path.join(root, "modules")] });
  daemon = d;
  // The work folder is outside the home: the security floor treats everything in VYRE_HOME as
  // Vyre's own state, as it does on a real machine.
  const work = fs.mkdtempSync(path.join(SCRATCH, "vyre-work-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const tool = (name, input, caller = "cli") => call(name, input, { root, caller, timeout: 20_000 });
  for (const [name, value] of Object.entries(vault)) {
    assert.ok((await tool("vault.put", { name, kind: name === "anthropic-api-key" ? "api-key" : "secret", fields: { value } })).data);
    // The provider sign-in items are never granted to a module (vault.launcherOnly): the session launcher reads them through the credentials port the daemon holds. Any other item is still a grant.
    if (name === "claude-setup-token" || name === "anthropic-api-key") continue;
    assert.equal((await tool("vault.grant", { name, module: "threads" })).data.grant.status, "active");
  }
  const launches = () => { try { return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const events = async id => (await tool("threads.get", { thread: id, limit: 500 })).data.events;
  const finished = async (id, n = 1) => until(async () => (await events(id)).filter(e => e.type === "thread.finished").length >= n, `turn ${n} of ${id.slice(0, 8)}`);
  const said = async id => (await events(id)).filter(e => e.type === "thread.text" && e.payload.done && !e.payload.notice).map(e => e.payload.text);
  /** Every prompt an ACP agent received, as the blocks it arrived in (the fake agent logs them when FAKE_ACP_LOG is set). */
  const acpPrompts = () => { try { return fs.readFileSync(process.env.FAKE_ACP_LOG || "", "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(x => x.prompt).map(x => x.prompt); } catch { return []; } };
  // Bounded like `tool` (20s): a direct registry call that never answers fails the test by name instead of leaving the whole file hanging until node's file timeout.
  const internal = (name, input = {}) => {
    let timer;
    const stuck = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${name} did not answer in 20s`)), 20_000); timer.unref?.(); });
    return Promise.race([d.registry.call(name, input, "module:vyred"), stuck]).finally(() => clearTimeout(timer));
  };
  return { root, d, work, tool, internal, launches, events, finished, said, acpPrompts, transcripts };
}

/**
 * A session a terminal `claude` wrote, as an older Claude Code left it: a summary line, no
 * entrypoint, version 1.0.40. `ageMs` 0 is a session busy in a terminal right now.
 */
export function terminalSession(transcripts, cwd, { ageMs = 120_000, id = crypto.randomUUID() } = {}) {
  const dir = path.join(transcripts, cwd.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const base = { sessionId: id, cwd, version: "1.0.40", userType: "external", isSidechain: false };
  fs.writeFileSync(file, [
    { type: "summary", summary: "Northwind Bakery menu", leafUuid: "u2" },
    { ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: new Date(Date.now() - ageMs).toISOString(), message: { role: "user", content: "start the menu for Northwind Bakery" } },
    { ...base, type: "assistant", uuid: "u2", parentUuid: "u1", timestamp: new Date(Date.now() - ageMs).toISOString(),
      message: { id: "msg_old_1", role: "assistant", model: "claude-3-5-sonnet", content: [{ type: "text", text: "Started the menu." }] } },
  ].map(l => JSON.stringify(l)).join("\n") + "\n");
  const when = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, when, when);
  return { id, file };
}
