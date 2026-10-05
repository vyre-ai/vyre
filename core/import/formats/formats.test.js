// @ts-check
// Codex and Gemini CLI readers: synthetic sessions in a made-up sample world, converted to Claude
// Code's shape and read back by the existing transcript reader. Credential files are planted and
// must never be opened; symlinks are never followed.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { tempHome } from "../../../test/helpers.js";
import * as codex from "../../sessions/drivers/codex/import.js";
import * as gemini from "../../sessions/drivers/gemini/import.js";
import { agentHomes, formatFor } from "./index.js";
import { scan } from "../scan.js";
import * as transcripts from "../../transcripts/index.js";
import { scanText } from "../../sync/scrub.js";

const jl = rows => rows.map(r => JSON.stringify(r)).join("\n") + "\n";
const ID = "0198aaaa-bbbb-4ccc-8ddd-000000000001", ID2 = "0198aaaa-bbbb-4ccc-8ddd-000000000002";
const CWD = "/home/alex/Work/harlow-site";

function codexHome(t) {
  const home = path.join(tempHome(t), "codex");
  const day = path.join(home, "sessions", "2026", "09", "12");
  fs.mkdirSync(day, { recursive: true });
  const long = "x".repeat(40_000);
  fs.writeFileSync(path.join(day, `rollout-2026-09-12T10-00-00-${ID}.jsonl`), jl([
    { timestamp: "2026-09-12T10:00:00.000Z", type: "session_meta", payload: { base_instructions: long, id: ID, cwd: CWD, timestamp: "2026-09-12T10:00:00.000Z" } },
    { timestamp: "2026-09-12T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<cwd>/x</cwd>\n</environment_context>" }] } },
    { timestamp: "2026-09-12T10:00:02.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the intake form on the Harlow Legal site" }] } },
    { timestamp: "2026-09-12T10:00:03.000Z", type: "response_item", payload: { type: "reasoning", summary: [] } },
    { timestamp: "2026-09-12T10:00:04.000Z", type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{\"command\":[\"ls\"]}", call_id: "c1" } },
    { timestamp: "2026-09-12T10:00:05.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "index.html\nform.js" } },
    { timestamp: "2026-09-12T10:00:06.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "The form posts to the wrong URL." }] } },
    { timestamp: "2026-09-12T10:00:07.000Z", type: "event_msg", payload: { type: "user_message", message: "dup" } },
  ]));
  // The older layout: a bare first line, then bare records, the folder only in the context message.
  fs.writeFileSync(path.join(day, `rollout-2026-09-12T11-00-00-${ID2}.jsonl`), jl([
    { id: ID2, timestamp: "2026-09-12T11:00:00.000Z", instructions: "be brief" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/home/alex/Work/northwind</cwd>\n</environment_context>" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Add opening hours to Northwind Bakery" }] },
    { type: "function_call", name: "shell", arguments: "{}", call_id: "d1" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
    { record_type: "state" },
  ]));
  return home;
}

test("codex: lists rollout files, finds the folder past a long first line, converts both layouts", t => {
  const home = codexHome(t);
  const l = codex.list(home);
  assert.deepEqual(l.map(f => f.id), [ID, ID2]);
  assert.equal(codex.head(home, l[0].file), CWD);
  assert.equal(codex.head(home, l[1].file), "/home/alex/Work/northwind");
  const c = codex.convert(home, l[0].file);
  assert.deepEqual([c.id, c.cwd, c.turns], [ID, CWD, 2]);
  const old = codex.convert(home, l[1].file);
  assert.deepEqual([old.id, old.cwd, old.turns], [ID2, "/home/alex/Work/northwind", 2]);
  // The Claude-shape reader accepts it: folder, session id, turns, times; tool traffic is not a turn.
  const out = path.join(tempHome(t), "projects", "-home-alex-Work-harlow-site", `${ID}.jsonl`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, c.text);
  const r = transcripts.read(out);
  assert.equal(r.cwd, CWD);
  assert.deepEqual(r.turns.map(x => [x.role, x.text]), [["user", "Fix the intake form on the Harlow Legal site"], ["assistant", "The form posts to the wrong URL."]]);
  assert.equal(r.title, "Fix the intake form on the Harlow Legal site");
  assert.equal(r.started, Date.parse("2026-09-12T10:00:01.000Z"));
  const lines = c.text.trim().split("\n").map(x => JSON.parse(x));
  assert.ok(lines.every(x => x.sessionId === ID && x.cwd === CWD && x.timestamp));
  assert.deepEqual(lines.find(x => Array.isArray(x.message.content) && x.message.content[0].type === "tool_use").message.content[0], { type: "tool_use", id: "c1", name: "shell", input: { command: ["ls"] } });
  assert.equal(lines.find(x => x.message.content[0]?.type === "tool_result").message.content[0].tool_use_id, "c1");
  assert.equal(lines[0].isMeta, true, "injected context is not something anyone said");
  assert.equal(scanText(c.text).safe, true, "the converted file passes the sync scrub");
});

function geminiHome(t) {
  const home = path.join(tempHome(t), "gemini");
  const hash = gemini.hashOf("/home/alex/Work/northwind");
  const chats = path.join(home, "tmp", hash, "chats");
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(path.join(chats, "session-2026-09-13T09-00-aaaa1111.jsonl"), jl([
    { sessionId: "sess-1", projectHash: hash, startTime: "2026-09-13T09:00:00.000Z", lastUpdated: "2026-09-13T09:00:00.000Z", kind: "main", directories: ["/home/alex/Work/northwind"] },
    { id: "m1", timestamp: "2026-09-13T09:00:01.000Z", type: "user", content: [{ text: "Write the Northwind Bakery menu page" }] },
    { id: "m2", timestamp: "2026-09-13T09:00:02.000Z", type: "gemini", content: "", toolCalls: [{ id: "t1", name: "write_file", args: { file_path: "menu.html" }, result: [{ functionResponse: { id: "t1", name: "write_file", response: { output: "ok" } } }] }] },
    { id: "m2", timestamp: "2026-09-13T09:00:03.000Z", type: "gemini", content: "Menu page written.", toolCalls: [{ id: "t1", name: "write_file", args: { file_path: "menu.html" }, result: [{ functionResponse: { id: "t1", name: "write_file", response: { output: "ok" } } }] }] },
    { id: "m3", timestamp: "2026-09-13T09:00:04.000Z", type: "user", content: "scratch that" },
    { $rewindTo: "m3" },
    { $set: { lastUpdated: "2026-09-13T09:00:05.000Z" } },
    { id: "m4", timestamp: "2026-09-13T09:00:06.000Z", type: "info", content: "update available" },
  ]));
  fs.writeFileSync(path.join(chats, "session-2026-09-14T09-00-bbbb2222.json"), JSON.stringify({ sessionId: "sess-2", projectHash: hash, startTime: "2026-09-14T09:00:00.000Z", messages: [
    { id: "a", timestamp: "2026-09-14T09:00:01.000Z", type: "user", content: "Hello kit" }, { id: "b", timestamp: "2026-09-14T09:00:02.000Z", type: "gemini", content: "Hi alex" }] }));
  return { home, hash, chats };
}

test("gemini: lists chats, resolves the folder by hashing candidates, converts jsonl and legacy json", t => {
  const { home, chats } = geminiHome(t);
  const l = gemini.list(home);
  assert.equal(l.length, 2);
  assert.equal(gemini.head(home, l[0].file), null, "no candidate, folder unknown");
  assert.equal(gemini.head(home, l[0].file, { candidates: ["/home/alex/Work/harlow-site", "/home/alex/Work/northwind/"] }), "/home/alex/Work/northwind");
  const c = gemini.convert(home, l[0].file);
  assert.deepEqual([c.id, c.cwd, c.turns], ["sess-1", "/home/alex/Work/northwind", 2], "directories that hash to the project give the folder");
  const out = path.join(tempHome(t), "p", "s.jsonl");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, c.text);
  const r = transcripts.read(out);
  assert.deepEqual(r.turns.map(x => [x.role, x.text]), [["user", "Write the Northwind Bakery menu page"], ["assistant", "Menu page written."]], "replaced, rewound and info records applied");
  assert.equal(r.cwd, "/home/alex/Work/northwind");
  const tool = c.text.trim().split("\n").map(x => JSON.parse(x)).find(x => x.message.content[0]?.type === "tool_use");
  assert.deepEqual(tool.message.content[0], { type: "tool_use", id: "t1", name: "write_file", input: { file_path: "menu.html" } });
  const j = gemini.convert(home, l[1].file, { cwd: "/home/alex/Work/northwind" });
  assert.deepEqual([j.id, j.turns], ["sess-2", 2]);
  assert.ok(chats);
});

test("scan: a source per detected agent, tagged, with real counts; an agent with no sessions is not listed", t => {
  const cx = codexHome(t), { home: gm } = geminiHome(t);
  const empty = path.join(tempHome(t), "codex");
  const r = scan([{ path: cx, kind: "codex" }, { path: gm, kind: "gemini-cli" }, { path: empty, kind: "codex" }], { candidates: ["/home/alex/Work/northwind"] });
  assert.deepEqual(r.sources.map(s => [s.agent, s.sessions]), [["codex", 2], ["gemini-cli", 2]]);
  assert.deepEqual(r.sources[0].folders.map(f => f.cwd).sort(), [CWD, "/home/alex/Work/northwind"]);
  assert.equal(r.sources[1].folders[0].cwd, "/home/alex/Work/northwind");
  const noCand = scan([{ path: gm, kind: "gemini-cli" }]);
  assert.equal(noCand.sources[0].folders[0].cwd, null);
  assert.equal(noCand.sources[0].folders[0].suggested, false);
  assert.equal(noCand.sources[0].folders[0].why, "the folder it ran in is unknown");
});

test("agentHomes: a temp home reads its own folders, never the person's", t => {
  const root = tempHome(t);
  const h = agentHomes(root, {});
  assert.deepEqual(h.map(x => x.path), [path.join(root, "codex"), path.join(root, "gemini")]);
  assert.equal(formatFor("claude"), null);
  assert.equal(formatFor("__proto__"), null);
});

test("credential files planted beside the sessions are never listed, matched or opened", t => {
  const cx = codexHome(t), { home: gm, hash } = geminiHome(t);
  const secrets = [path.join(cx, "auth.json"), path.join(cx, "sessions", "auth.json"), path.join(gm, "oauth_creds.json"), path.join(gm, "google_accounts.json"), path.join(gm, ".env"), path.join(gm, "tmp", hash, ".env"),
    path.join(gm, "tmp", hash, "chats", "oauth_creds.json"), path.join(cx, "sessions", "2026", "09", "12", "auth.json")];
  for (const s of secrets) fs.writeFileSync(s, "{\"token\":\"SECRET-CREDENTIAL\"}");
  const spy = [];
  const open = fs.openSync, read = fs.readFileSync, rs = fs.readSync;
  fs.openSync = (p, ...a) => { spy.push(String(p)); return open(p, ...a); };
  fs.readFileSync = (p, ...a) => { spy.push(String(p)); return read(p, ...a); };
  try {
    const r = scan([{ path: cx, kind: "codex" }, { path: gm, kind: "gemini-cli" }], { candidates: ["/home/alex/Work/northwind"] });
    for (const f of r.files.values()) { (f.format === "codex" ? codex : gemini).convert(f.home, f.file, {}); }
    for (const s of secrets) {
      assert.throws(() => codex.convert(cx, s), /this reader may open/, s);
      assert.throws(() => gemini.convert(gm, s), /this reader may open/, s);
      assert.equal(codex.head(cx, s), null);
    }
  } finally { fs.openSync = open; fs.readFileSync = read; fs.readSync = rs; }
  assert.ok(spy.length > 4, "the spy saw the reads");
  assert.deepEqual(spy.filter(p => /auth\.json|oauth_creds|google_accounts|\.env|credentials/.test(p)), [], "a credential file was opened");
  assert.equal(codex.list(cx).length + gemini.list(gm).length, 4);
});

test("a reader refuses a path outside its allowlist, even a readable transcript-looking one", t => {
  const cx = codexHome(t), other = path.join(tempHome(t), "elsewhere", "rollout-x.jsonl");
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, "{}\n");
  assert.throws(() => codex.convert(cx, other), /this reader may open/);
  assert.throws(() => codex.convert(cx, path.join(cx, "sessions", "..", "..", "elsewhere", "rollout-x.jsonl")), /this reader may open/);
  assert.throws(() => gemini.convert(cx, other), /this reader may open/);
});

test("symlinks are never followed: a linked file and a linked day folder", t => {
  const cx = codexHome(t);
  const scratch = tempHome(t);
  const day = path.join(cx, "sessions", "2026", "09", "12");
  const target = path.join(scratch, "real.jsonl");
  fs.writeFileSync(target, jl([{ timestamp: "2026-09-12T10:00:00.000Z", type: "session_meta", payload: { id: "linked", cwd: "/x" } }]));
  fs.symlinkSync(target, path.join(day, "rollout-2026-09-12T12-00-00-0198aaaa-bbbb-4ccc-8ddd-000000000003.jsonl"));
  fs.symlinkSync(path.join(cx, "sessions", "2026", "09", "12"), path.join(cx, "sessions", "2026", "09", "13"));
  assert.deepEqual(codex.list(cx).map(f => f.id), [ID, ID2], "linked file and linked folder skipped");
  const link = path.join(day, "rollout-2026-09-12T12-00-00-0198aaaa-bbbb-4ccc-8ddd-000000000003.jsonl");
  assert.throws(() => codex.convert(cx, link), /regular file/);
  const { home: gm, chats } = geminiHome(t);
  fs.symlinkSync(path.join(chats, "session-2026-09-14T09-00-bbbb2222.json"), path.join(chats, "session-linked.json"));
  assert.equal(gemini.list(gm).length, 2);
  assert.ok(crypto);
});
