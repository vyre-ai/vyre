// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { lentProcessProvider, syncRootsFor, workTranscriptPath, serverTranscriptPlace, manifestSessionFilePattern, restorableAgentRel, grokCwdKey, grokSessionRemote } from "./lent-agent.js";

const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("lent-agent: process providers and sync roots", () => {
  assert.equal(lentProcessProvider("claude"), "claude");
  assert.equal(lentProcessProvider("codex"), "codex");
  assert.equal(lentProcessProvider("grok"), "grok");
  assert.equal(lentProcessProvider("openrouter"), null);
  assert.deepEqual(syncRootsFor("codex")[0].remote, "agent/codex");
});

test("lent-agent: work transcript paths per provider", () => {
  const w = "/mnt";
  assert.match(workTranscriptPath("claude", w, "/proj", ID), /\.claude\/projects\/-proj\//);
  assert.match(workTranscriptPath("codex", w, "/proj", ID), /\.codex\/sessions\//);
  assert.match(workTranscriptPath("grok", w, "/proj", ID), /\.grok\/sessions\//);
});

test("lent-agent: server transcript place for claude and codex", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lent-agent-"));
  const projects = path.join(dir, "projects", "-work");
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, `${ID}.jsonl`), '{"x":1}\n');
  const cl = serverTranscriptPlace({ provider: "claude", folders: [path.join(dir, "projects")], cwd: "/work", native: ID });
  assert.ok(cl && cl.file.endsWith(`${ID}.jsonl`));
  const codexHome = path.join(dir, "codex");
  const rollout = path.join(codexHome, "sessions", "2026", "01", "02", `rollout-1-${ID}.jsonl`);
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, '{"type":"session_meta"}\n');
  const cx = serverTranscriptPlace({ provider: "codex", folders: [], cwd: "/w", native: ID, accountHome: codexHome });
  assert.ok(cx && path.basename(cx.file).includes(ID.slice(0, 8)));
  assert.ok(manifestSessionFilePattern("codex", ID, ID).test(`agent/codex/sessions/2026/01/02/rollout-1-${ID}.jsonl`));
  assert.ok(restorableAgentRel("codex", "sessions/2026/01/02/rollout-x.jsonl"));
});

test("lent-agent: grok cwd keys stay short for real-length workspace paths", () => {
  const short = grokCwdKey("/proj");
  assert.ok(short.length <= 120);
  const long = "/home/member/" + "deep/nested/".repeat(40);
  const key = grokCwdKey(long);
  assert.match(key, /^h-[0-9a-f]{32}$/);
  assert.ok(grokSessionRemote(long, ID).length < 200);
  assert.equal(grokCwdKey(long), grokCwdKey(long));
});
