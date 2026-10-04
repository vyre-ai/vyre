// @ts-check
import "./mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { textOf, scrub, clientPattern } from "./real-use-extract.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "real-use-extract.mjs");
const KEY = ["sk", "live", "51NcanaryNOTREAL0000000000000000"].join("_");

test("textOf keeps typed turns and assistant text, and drops meta, system reminders, tool results and thinking", () => {
  assert.equal(textOf({ type: "user", isMeta: true, message: { content: "CLAUDE.md contents about Acme" } }), "");
  assert.equal(textOf({ type: "user", message: { content: [{ type: "tool_result", content: "secret stuff" }] } }), "");
  assert.equal(textOf({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "The port is 41873." }] } }), "The port is 41873.");
  assert.equal(textOf({ type: "user", message: { content: "<system-reminder>Acme memory index</system-reminder>use port 41873 please" } }), "use port 41873 please");
});

test("scrub redacts a key, an email, an address and a home path", () => {
  const t = scrub(`key ${KEY} mail robin@harlow.example host ${[203, 0, 113, 7].join(".")} at ${["", "Users", "zed", "x"].join("/")} see https://zed.example.run and /private/tmp/claude-501/-Users-a-b/scratch`, /\bzed\b/gi);
  assert.ok(!t.includes(KEY) && !t.includes("robin@") && !t.includes("203.0.113") && !/zed/i.test(t) && !t.includes("claude-501"));
  assert.match(t, /\[email\]/); assert.match(t, /\[ip\]/);
});

test("the client pattern comes from a file, is case-insensitive and refuses an empty list", () => {
  const re = clientPattern(["# comment", "Acme", "Zenith Law", "firms?"]);
  for (const w of ["acme", "Zenith Law LLP", "two firms"]) assert.ok(new RegExp(re.source, "i").test(w), w);
  assert.throws(() => clientPattern(["# nothing", ""]), /no client filter/);
});

test("a folder run: a session with heavy client talk is dropped, a passing mention is replaced, a canary never reaches the output", () => {
  const denyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ru-deny-")), "deny.txt"); fs.writeFileSync(denyFile, "Acme\nZenith Law\n");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ru-")), out = fs.mkdtempSync(path.join(os.tmpdir(), "ru-out-"));
  const line = (/** @type {any} */ o) => JSON.stringify({ cwd: "/Users/x/Claude/Orgs/Proj/work", timestamp: "2026-09-30T10:00:00Z", ...o });
  const body = (/** @type {string} */ extra, /** @type {boolean} */ everywhere) => Array.from({ length: 12 }, (_, i) => line({ type: i % 2 ? "assistant" : "user", message: { content: i % 2 ? [{ type: "text", text: `Step ${i}: the retry delay is ${i * 5}s and the commit is 9c41e7a${i}. ${everywhere || i === 3 ? extra : ""} ${KEY}` }] : `please continue number ${i} on the billing webhook and report the exact figures back ${"detail ".repeat(60)}` } })).join("\n");
  fs.writeFileSync(path.join(dir, "good.jsonl"), body("One mention of Acme once."));
  fs.writeFileSync(path.join(dir, "bad.jsonl"), body("Acme Acme Zenith Law client work.", true));
  execFileSync(process.execPath, [SCRIPT, dir, out, "--under", "/Users/x/Claude/Orgs/Proj", "--deny", denyFile, "--owner", "zed", "--max-chars", "100000"]);
  const corpus = fs.readFileSync(path.join(out, "corpus.json"), "utf8");
  const c = JSON.parse(corpus);
  assert.equal(c.sessions.length, 1, "only the good session is kept");
  assert.ok(!corpus.includes(KEY) && !/\bAcme\b/.test(corpus) && corpus.includes("[client]"));
});
