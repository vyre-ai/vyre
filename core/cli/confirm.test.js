// @ts-check
// The stopgap before a human-only learn tool: a terminal, /dev/tty, and the id typed back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { confirm, HUMAN_TOOLS } from "./confirm.js";

/** A terminal that answers `typed`, and records what it was shown. */
const io = ({ tty = true, opens = true, typed = "", present = false } = {}) => {
  const shown = [];
  return {
    shown,
    verifier: () => present,
    isTTY: () => tty,
    open: () => {
      if (!opens) throw Object.assign(new Error("Device not configured"), { code: "ENXIO" });
      return { write: s => { shown.push(s); }, readLine: () => typed, close: () => {} };
    },
  };
};
const ask = { token: 7, summary: 'Retire lesson 7: "Never push to main." [block]', what: "learn.retire 7" };

test("confirm: no terminal, or no /dev/tty (Claude's Bash), refuses without asking", () => {
  assert.equal(confirm(ask, io({ tty: false, typed: "7" })).ok, false);
  const r = confirm(ask, io({ opens: false, typed: "7" }));
  assert.equal(r.ok, false);
  assert.match(/** @type {any} */ (r).why, /needs you at a terminal/);
});

test("confirm: the person reads the summary and types the id back", () => {
  const t = io({ typed: " 7 " });
  assert.deepEqual(confirm(ask, t), { ok: true, via: "tty" });
  assert.match(t.shown.join(""), /Never push to main\.[\s\S]*Type 7 to confirm/);
  const wrong = confirm(ask, io({ typed: "y" }));
  assert.equal(wrong.ok, false);
  assert.match(/** @type {any} */ (wrong).why, /not confirmed/);
});

test("confirm: with ADR 0004's verifier installed, vyred checks presence and nothing is asked here", () => {
  const t = io({ tty: false, present: true });
  assert.deepEqual(confirm(ask, t), { ok: true, via: "presence" });
  assert.equal(t.shown.length, 0);
});

test("confirm: the real terminal in a shell with no controlling terminal refuses", { skip: process.platform === "win32" }, () => {
  // setsid is not on macOS; a detached child has no controlling terminal either way, as Claude's Bash has none.
  const code = `import("${new URL("./confirm.js", import.meta.url).href}").then(m => { const r = m.confirm({ token: 1, summary: "x", what: "learn.retire 1" }); process.stdout.write(JSON.stringify(r)); })`;
  const r = spawnSync(process.execPath, ["-e", code], { input: "1\n", encoding: "utf8", detached: true });
  assert.equal(JSON.parse(r.stdout).ok, false);
  assert.deepEqual(HUMAN_TOOLS, ["learn.accept", "learn.retire", "learn.relax", "learn.skill-install", "learn.skill-retire", "learn.skill-dismiss"]);
});
