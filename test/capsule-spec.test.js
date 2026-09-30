// @ts-check
// Shape check for spec/capsule/*.json (C2): the golden vectors the Mac Capsule (Swift) and the
// Windows panel (JavaScript) both test against. This file checks SHAPE only -- every case has
// input and expect, ids are unique, every file carries "v": 1 -- and never reimplements Route,
// CLIRun or Match in JavaScript. Proving the vectors true against the real Swift code is
// Tests/SpecVectorsTests.swift's job, on GitHub Actions.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_DIR = path.join(ROOT, "spec", "capsule");

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(SPEC_DIR, name), "utf8"));
}

test("every spec file exists and carries v: 1", () => {
  for (const name of ["route.json", "commands.json", "match.json", "strings.json", "keys.json"]) {
    const p = path.join(SPEC_DIR, name);
    assert.ok(fs.existsSync(p), `${name} is missing`);
    const doc = load(name);
    assert.equal(doc.v, 1, `${name}: v must be 1`);
  }
});

function checkCases(name, cases) {
  assert.ok(Array.isArray(cases) && cases.length > 0, `${name}: cases must be a non-empty array`);
  for (const [i, c] of cases.entries()) {
    assert.ok(Object.prototype.hasOwnProperty.call(c, "input"), `${name}[${i}]: missing input`);
    assert.ok(Object.prototype.hasOwnProperty.call(c, "expect"), `${name}[${i}]: missing expect`);
    assert.ok(c.input && typeof c.input === "object", `${name}[${i}]: input must be an object`);
    assert.ok(typeof c.input.fn === "string" && c.input.fn.length > 0, `${name}[${i}]: input.fn must name the function under test`);
  }
}

test("route.json: every case has input.fn, input and expect; catalogs and threadSets resolve", () => {
  const doc = load("route.json");
  checkCases("route.json", doc.cases);
  assert.ok(doc.world && typeof doc.world.now === "number" && typeof doc.world.day === "number", "route.json: world.now and world.day must be numbers");
  assert.ok(doc.catalogs && doc.catalogs.default, "route.json: catalogs.default must exist");
  const catalogNames = new Set(Object.keys(doc.catalogs));
  for (const [i, c] of doc.cases.entries()) {
    if (c.input.catalog !== undefined) {
      assert.ok(catalogNames.has(c.input.catalog), `route.json[${i}]: catalog "${c.input.catalog}" is not defined in catalogs`);
    }
    if (c.input.agentThreads !== undefined) {
      assert.ok(doc.threadSets && Object.prototype.hasOwnProperty.call(doc.threadSets, c.input.agentThreads),
        `route.json[${i}]: agentThreads "${c.input.agentThreads}" is not defined in threadSets`);
    }
  }
  // Every threadSet's own catalog reference resolves, and every id it pulls exists in that catalog.
  for (const [key, ts] of Object.entries(doc.threadSets || {})) {
    assert.ok(catalogNames.has(ts.catalog), `route.json: threadSets.${key}.catalog "${ts.catalog}" is not defined in catalogs`);
    const ids = new Set((doc.catalogs[ts.catalog].threads || []).map((t) => t.id));
    for (const id of ts.ids || []) assert.ok(ids.has(id), `route.json: threadSets.${key} references thread "${id}", not in catalogs.${ts.catalog}`);
  }
});

test("commands.json: every case has input.fn, input and expect", () => {
  const doc = load("commands.json");
  checkCases("commands.json", doc.cases);
  for (const c of doc.cases) {
    assert.ok(["parse", "forCapsule", "refused"].includes(c.input.fn), `commands.json: unknown fn "${c.input.fn}"`);
  }
});

test("match.json: every case has input.fn, input and expect", () => {
  const doc = load("match.json");
  checkCases("match.json", doc.cases);
  for (const c of doc.cases) {
    assert.ok(["score", "words", "hits"].includes(c.input.fn), `match.json: unknown fn "${c.input.fn}"`);
  }
});

test("strings.json: every string has an id, text and where; ids are unique; leaks is a boolean", () => {
  const doc = load("strings.json");
  assert.ok(Array.isArray(doc.strings) && doc.strings.length > 0, "strings.json: strings must be a non-empty array");
  const seen = new Set();
  let leakCount = 0;
  for (const [i, s] of doc.strings.entries()) {
    assert.ok(typeof s.id === "string" && s.id.length > 0, `strings.json[${i}]: missing id`);
    assert.ok(!seen.has(s.id), `strings.json: duplicate id "${s.id}"`);
    seen.add(s.id);
    assert.ok(typeof s.text === "string" && s.text.length > 0, `strings.json[${s.id}]: missing text`);
    assert.ok(typeof s.where === "string" && s.where.length > 0, `strings.json[${s.id}]: missing where`);
    assert.ok(typeof s.leaks === "boolean", `strings.json[${s.id}]: leaks must be a boolean`);
    if (s.leaks) leakCount += 1;
  }
  assert.ok(leakCount > 0, "strings.json: expected at least one leaking string flagged (vyred/switchboard/internal tool names)");
});

test("keys.json: global and panel keys have ids and actions; ids are unique across both lists", () => {
  const doc = load("keys.json");
  assert.ok(Array.isArray(doc.global) && doc.global.length > 0, "keys.json: global must be a non-empty array");
  assert.ok(Array.isArray(doc.panel) && doc.panel.length > 0, "keys.json: panel must be a non-empty array");
  const seen = new Set();
  for (const list of [doc.global, doc.panel]) {
    for (const k of list) {
      assert.ok(typeof k.id === "string" && k.id.length > 0, "keys.json: every key entry needs an id");
      assert.ok(!seen.has(k.id), `keys.json: duplicate id "${k.id}"`);
      seen.add(k.id);
      assert.ok(Array.isArray(k.keys) && k.keys.length > 0, `keys.json[${k.id}]: keys must be a non-empty array`);
      assert.ok(typeof k.action === "string" && k.action.length > 0, `keys.json[${k.id}]: missing action`);
    }
  }
  assert.ok(doc.footer_hints && Array.isArray(doc.footer_hints.states) && doc.footer_hints.states.length > 0,
    "keys.json: footer_hints.states must be a non-empty array");
  const stateIds = new Set();
  for (const s of doc.footer_hints.states) {
    assert.ok(typeof s.id === "string" && s.id.length > 0, "keys.json: every footer state needs an id");
    assert.ok(!stateIds.has(s.id), `keys.json: duplicate footer state id "${s.id}"`);
    stateIds.add(s.id);
    assert.ok(Array.isArray(s.hints), `keys.json[footer_hints.${s.id}]: hints must be an array`);
  }
});
