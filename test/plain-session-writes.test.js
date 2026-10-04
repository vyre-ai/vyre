// @ts-check
// The mechanical sweep (4 Oct): every tool that changes state or acts outward and that a PLAIN model session (a bare `mcp` or `harness`, no thread, no agent) can reach must, on a real daemon, refuse it, hold it
// for the person, or be on the short list in test/plain-session-writes.json with its reason. The probe is a call whose input no tool declares: a call that passes every gate answers `bad_input` and never
// runs (the registry checks the input after the gates), so the sweep changes nothing. A tool that is refused or held for the person answers denied, held_unavailable, presence_required, no_such_tool,
// person_session_required or not_declared. Real daemon, kernel on, temp home, fakes only.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";
import { FAKE } from "../core/sessions/testing/boot.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "plain-session-writes.json");

test("a plain model session reaches no write or outward tool but the listed ones", { timeout: 300_000 }, async t => {
  const root = fs.realpathSync(tempHome(t));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box" }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const reg = d.registry;
  /** @type {Record<string, string[]>} */ const reach = {};
  const names = [...reg.tools.entries()].filter(([, def]) => !def.internal && !def.hook);
  for (const caller of ["mcp", "harness"]) {
    for (const [name, def] of names) {
      if (def.effect === "read") continue;
      const r = await reg.call(name, { "__probe__": 1 }, caller, {});
      const code = r && r.error ? r.error.code : "ran";
      if (code === "bad_input" || code === "ran") (reach[name] ||= []).push(caller);
    }
  }
  const allowed = JSON.parse(fs.readFileSync(FILE, "utf8")).allowed;
  const extra = Object.keys(reach).filter(n => !(n in allowed));
  assert.deepEqual(extra, [], "a plain session reaches these write tools: refuse them, hold them for the person, or list them in test/plain-session-writes.json with the reason");
  const stale = Object.keys(allowed).filter(n => !(n in reach));
  assert.deepEqual(stale, [], "listed but no longer reachable: remove from test/plain-session-writes.json");
  // Second look: a tool listed as refused in its body must still refuse a plain session when it is handed the input it asks for (not just a probe), so a body check that is dropped shows here.
  const dummy = (/** @type {any} */ sc, /** @type {string} */ k) => {
    if (!sc) return "x";
    if (sc.enum) return sc.enum[0];
    switch (sc.type) { case "integer": case "number": return sc.minimum ?? 1; case "boolean": return false; case "array": return []; case "object": return fill(sc); default: return k === "to" ? "a@b.test" : "x"; }
  };
  const fill = (/** @type {any} */ sc) => Object.fromEntries((sc.required || []).map((/** @type {string} */ k) => [k, dummy((sc.properties || {})[k], k)]));
  /** @type {string[]} */ const open = [];
  for (const [name, why] of Object.entries(allowed)) {
    if (/** @type {any} */ (why).class !== "refused") continue;
    const def = reg.tools.get(name);
    const r = await reg.call(name, def && def.input && def.input.type === "object" ? fill(def.input) : {}, "mcp", {});
    if (!r.error || !["denied", "not_asked", "forbidden", "not_allowed", "failed"].includes(r.error.code)) open.push(`${name}: ${r.error ? r.error.code : "ran"}`);
  }
  assert.deepEqual(open, [], "listed as refused for a plain session, but it was not");
  // Nothing may be left for review without an owner: the number only shrinks.
  const review = Object.entries(allowed).filter(([, v]) => /** @type {any} */ (v).class === "review").map(([n]) => n);
  assert.ok(review.length <= 5, "tools waiting for an owner's decision: " + review.join(", "));
});

test("a plain model session acts on no thread that is not its own: stop, interrupt, send, archive, delete, fork, watch, switch, unarchive on another's thread are refused and the thread is untouched", { timeout: 300_000 }, async t => {
  const root = fs.realpathSync(tempHome(t));
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  process.env.VYRE_SESSION_SANDBOX_OFF = "1";
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on", max_live: 50 } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(root, "work-")));
  const made = await d.registry.call("threads.start", { cwd: work, prompt: "the person's own thread", surface: "deck" }, "cli");
  assert.ok(made.data && made.data.id, JSON.stringify(made));
  const id = made.data.id;
  const before = (await d.registry.call("threads.get", { thread: id }, "cli")).data.thread;
  const probes = [["threads.stop", {}], ["threads.interrupt", {}], ["threads.send", { text: "do something else" }], ["threads.archive", {}], ["threads.delete", {}], ["threads.fork", { prompt: "x" }],
    ["threads.watch", {}], ["threads.switch", { provider: "claude" }], ["threads.unarchive", {}], ["threads.unwatch", {}], ["threads.rewind", {}]];
  /** @type {string[]} */ const open = [];
  for (const caller of ["mcp", "harness"]) {
    for (const [tool, extra] of probes) {
      const r = await d.registry.call(tool, { thread: id, ...extra }, caller, {});
      if (!r.error) open.push(`${caller} ${tool}`);
    }
  }
  const after = (await d.registry.call("threads.get", { thread: id }, "cli")).data.thread;
  assert.equal(after.status, before.status, "the thread was not stopped, archived or changed");
  assert.deepEqual(open, [], "a plain session got through to another's thread");
});
