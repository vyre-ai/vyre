// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { summarize, readLog, logLines, kindOf } from "./doctor-log.js";
import { tempHome } from "../../../test/helpers.js";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const at = (/** @type {number} */ hoursAgo, /** @type {string} */ msg) => `${new Date(NOW - hoursAgo * 3600e3).toISOString()} ${msg}`;

test("doctor log: counts errors, warnings by kind, slow calls, retries and module restarts over the last 24 h only", () => {
  const log = [
    at(30, "error: [mail] too old to count"),
    at(23, "vyred 0.6.7 up · role box · 3 modules"),
    at(23, "module mail 0.1.0 running"), at(23, "module pearl 0.1.0 running"),
    at(5, "module pearl 0.1.0 running"),
    at(4, "error: [mail] could not reach the server"), at(4, "module quill failed to start: boom"),
    at(3, "warn: [pearl] a tool took long"), at(3, "warn: [pearl] another"), at(2, "warn: module marlow invalid: no tools"),
    at(2, "warn: slow call files.list took 2750 ms"), at(1, "warn: slow call threads.send took 4100 ms"),
    at(1, "relay: another box took this route; retrying in 5 minutes"),
    "not a log line",
  ];
  const r = summarize(log, NOW);
  assert.equal(r.errors, 2);
  assert.deepEqual(r.errorKinds, [["mail", 1], ["module quill", 1]], "kinds are listed most first, then by name");
  assert.equal(r.warnings, 3);
  assert.deepEqual(r.warningKinds, [["pearl", 2], ["module marlow", 1]]);
  assert.deepEqual(r.slow, [{ tool: "files.list", ms: 2750 }, { tool: "threads.send", ms: 4100 }]);
  assert.equal(r.retries, 1);
  assert.equal(r.starts, 1);
  assert.equal(r.restarts, 1, "pearl started twice with one vyred start");
  assert.deepEqual(r.restarted, [["pearl", 1]]);
  const text = logLines(r).join("\n");
  assert.match(text, /errors: 2/);
  assert.match(text, /slow calls over 2 s: 2 \(threads\.send 4100 ms, files\.list 2750 ms\)/);
  assert.match(text, /module restarts: 1 \(pearl: 1\)/);
});

test("doctor log: a slow call or a retry at or before vyred is up is warmup, and an error still counts", () => {
  const up = at(1, "vyred 0.6.8 up · role box · 2 modules");
  const stamp = up.slice(0, up.indexOf(" "));
  const later = new Date(Date.parse(stamp) + 1000).toISOString();
  const r = summarize([
    `${stamp} warn: slow call files.list took 2500 ms`,
    `${stamp} relay: the route moved; retrying in 1 s`,
    `${stamp} error: the store did not open`,
    up,
    `${later} warn: slow call threads.send took 3100 ms`,
    `${later} relay: another try; retrying in 1 s`,
  ], NOW);
  assert.equal(r.errors, 1);
  assert.deepEqual(r.slow, [{ tool: "threads.send", ms: 3100 }]);
  assert.equal(r.retries, 1);
  assert.equal(r.starts, 1);
  const none = summarize([at(1, "warn: slow call files.list took 2500 ms"), at(1, "retrying the send")], NOW);
  assert.equal(none.slow.length, 1, "no up line: a slow call still counts");
  assert.equal(none.retries, 1);
});

test("doctor log: a quiet log says zero everywhere", () => {
  const r = summarize([at(1, "vyred 0.6.7 up · role box · 1 modules"), at(1, "module mail 0.1.0 running")], NOW);
  assert.deepEqual([r.errors, r.warnings, r.slow.length, r.retries, r.restarts], [0, 0, 0, 0, 0]);
  assert.deepEqual(logLines(r).slice(1), ["  errors: 0", "  warnings: 0", "  slow calls over 2 s: 0", "  retries: 0", "  module restarts: 0"]);
});

test("doctor log: readLog takes the day files that reach into the window, and null with no folder", t => {
  const dir = path.join(tempHome(t), "logs-test");
  assert.equal(readLog(dir, NOW), null);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "2026-10-19.log"), at(60, "error: [mail] old") + "\n");
  fs.writeFileSync(path.join(dir, "2026-10-20.log"), at(20, "error: [mail] yesterday") + "\n");
  fs.writeFileSync(path.join(dir, "2026-10-21.log"), at(2, "warn: [mail] today") + "\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a log\n");
  const r = summarize(readLog(dir, NOW) || [], NOW);
  assert.equal(r.errors, 1);
  assert.equal(r.warnings, 1);
});

test("doctor log: kindOf names a warning by its tag, its module or its first words", () => {
  assert.equal(kindOf("[pearl] x"), "pearl");
  assert.equal(kindOf("module marlow invalid: y"), "module marlow");
  assert.equal(kindOf("config: bad value here"), "config: bad");
});
