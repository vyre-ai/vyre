// @ts-check
// A thread started after a skill is approved is given it (R031-19, Claude): the library's approved skills, written once per content as a plugin folder, ride the thread's `--plugin-dir` beside the Harness. A thread
// of a project sees that project's skills and another project's thread does not. Real vyred (kernel on) on the fake claude, temp home.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";
import { tempHome } from "./helpers.js";
import { canonical } from "../kernel/core/canonical.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "core", "switchboard", "testing", "fake-claude.js");
fs.chmodSync(FAKE, 0o755);
const used = new Set();
const presence = { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_payload") };
const until = async (/** @type {() => any} */ f, /** @type {string} */ what, ms = 25_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out: ${what}`); await new Promise(r => setTimeout(r, 100)); } };
const skill = (/** @type {string} */ name) => `---\nname: ${name}\ndescription: Use when the work is about ${name} and nothing else.\n---\n\n# ${name}\n\nDo it.\n`;

test("a thread is given the Space's approved library as a plugin folder; a project's skill reaches that project's threads only", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  const log = path.join(root, "claude.log");
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG, VYRE_SESSION_SANDBOX_OFF: process.env.VYRE_SESSION_SANDBOX_OFF };
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_LOG: log, VYRE_SESSION_SANDBOX_OFF: "1" });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", sessions: { install: false }, projectsDir: path.join(root, "projects") }));
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence });
  t.after(() => d.stop());
  const chain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(chain, {})).token });
  const tool = async (/** @type {string} */ name, /** @type {any} */ input = {}) => { const r = await d.registry.call(name, input, "cli", await meta()); if (r.error) throw new Error(`${name}: ${r.error.message}`); return r.data; };
  const launches = () => { try { return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const dirsOf = (/** @type {string[]} */ argv) => argv.flatMap((a, i) => (a === "--plugin-dir" ? [argv[i + 1]] : []));

  const rivera = await tool("projects.create", { name: "Rivera" }), harlow = await tool("projects.create", { name: "Harlow" });
  for (const [name, level, scope] of [["house-style", "space", ""], ["rivera-rules", "project", rivera.slug]]) {
    const dr = await tool("skills.draft", { name, level, ...(scope ? { scope } : {}), body: skill(name) });
    await tool("skills.approve", { name, level, ...(scope ? { scope } : {}), version: dr.version });
  }
  await tool("threads.start", { project: rivera.slug, name: "r", prompt: "hi", surface: "deck" });
  await tool("threads.start", { project: harlow.slug, name: "h", prompt: "hi", surface: "deck" });
  const [a, b] = await until(() => (launches().length >= 2 ? launches() : null), "two launches");
  const skillsOf = (/** @type {any} */ l) => dirsOf(l.argv).flatMap(dir => { try { return fs.readdirSync(path.join(dir, "skills")); } catch { return []; } });
  const rv = skillsOf(a).sort(), hv = skillsOf(b).sort();
  assert.deepEqual(rv.filter(n => n === "house-style" || n === "rivera-rules"), ["house-style", "rivera-rules"], `Rivera's thread has the Space's and its own: ${JSON.stringify(dirsOf(a.argv))}`);
  assert.deepEqual(hv.filter(n => n === "house-style" || n === "rivera-rules"), ["house-style"], "Harlow's thread has the Space's only");
});
