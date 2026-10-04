// @ts-check
// One bad session start must never end the daemon for everyone (RC1, dev box 5 Oct: an agent program that was not an absolute path threw inside the sandbox's agent check, an unhandled
// rejection, and vyred exited 70). A session whose agent program is missing, relative or not executable fails ITS OWN start with a plain reason, and the daemon answers afterwards.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";
import { SCRATCH } from "./scratch.mjs";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
delete process.env.VYRE_SESSION_SANDBOX_OFF;

for (const [name, bin] of [["missing", "vyre-no-such-agent-xyz"], ["relative", "./not-absolute-agent"], ["not executable", "NOTEXEC"]]) {
  test(`an agent program that is ${name}: that session fails with a plain reason, no unhandled rejection, and the daemon still answers`, { timeout: 120_000 }, async t => {
    const root = tempHome(t);
    const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-bad-agent-"))); t.after(() => fs.rmSync(work, { recursive: true, force: true }));
    let program = bin;
    if (bin === "NOTEXEC") { program = path.join(work, "agent-not-executable"); fs.writeFileSync(program, "#!/bin/sh\necho hi\n", { mode: 0o644 }); }
    const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER };
    Object.assign(process.env, { VYRE_CLAUDE_BIN: program, VYRE_SESSIONS_DRIVER: "cli" });
    t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", sessions: { install: false } }));
    const rejections = /** @type {any[]} */ ([]);
    const onRej = (/** @type {any} */ e) => rejections.push(e);
    process.on("unhandledRejection", onRej); t.after(() => process.off("unhandledRejection", onRej));
    const d = await start({ root, presence: present, log: () => {}, kernel: true });
    t.after(() => d.stop());
    const r = await d.registry.call("threads.start", { cwd: work, prompt: "hello", surface: "deck" }, "cli");
    // either the start itself is refused, or the thread is created and then fails: never a crash
    if (r.error) assert.match(r.error.message, /did not start|not found|not installed|program|sandbox|safety check/i, JSON.stringify(r.error));
    await new Promise(res => setTimeout(res, 1500));
    assert.deepEqual(rejections.map(e => String(e && e.message)), [], "no unhandled rejection");
    const echo = await d.registry.call("system.echo", { text: "still here" }, "cli");
    assert.ok(echo && !echo.error, "the daemon still answers: " + JSON.stringify(echo));
  });
}
