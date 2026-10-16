// A checkpoint never uploads a credential file from the agent's home folder to the Space: a member's own AI sign-in and the OAuth tokens of the MCP servers they signed in to
// live there (Claude's .credentials.json, Codex's auth.json), and the Space's server and owner must not be able to read them.
import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { createSessionSync, localReaderFor } from "./sync.js";
import { isCredentialFile } from "../../lib/drivers/credfiles.js";
import { fakeSpace } from "./testing/fake-space.js";

const tmp = () => fs.mkdtempSync(path.join(SCRATCH, "nocreds-"));
const setup = () => { const a = tmp(); for (const d of ["work/files", "work/home/.claude", "state"]) fs.mkdirSync(path.join(a, d), { recursive: true }); return a; };
const mk = (a, sp) => createSessionSync({ space: sp.sync, session: "s1", work: path.join(a, "work"), state: path.join(a, "state"), reader: localReaderFor(path.join(a, "work")), seal: s => s });
const SECRET = "SECRET-MCP-OAUTH-TOKEN";

test("isCredentialFile: the known credential names, any case, anywhere under the agent home; ordinary files are not", () => {
  for (const rel of [".credentials.json", "home/.claude/.credentials.json", "x/.CREDENTIALS.JSON", ".claude.json", "auth.json", ".oauth_token", ".api_key", ".session_ingress_token", ".credentials.json.bak", "a/b/.credentials.tmp-1"]) assert.equal(isCredentialFile(rel), true, rel);
  for (const rel of ["projects/p/abc.jsonl", "settings.json", "skills/credentials-guide.md", "notes.txt", "CLAUDE.md"]) assert.equal(isCredentialFile(rel), false, rel);
});

test("a checkpoint with .credentials.json in the agent home does not upload it, and still uploads the rest", async () => {
  const sp = fakeSpace(), a = setup();
  const home = path.join(a, "work/home/.claude");
  fs.writeFileSync(path.join(home, ".credentials.json"), JSON.stringify({ mcpOAuth: { "g|1": { accessToken: SECRET } }, claudeAiOauth: { accessToken: SECRET } }));
  fs.writeFileSync(path.join(home, "auth.json"), SECRET);
  fs.mkdirSync(path.join(home, "projects/p"), { recursive: true });
  fs.writeFileSync(path.join(home, "projects/p/abc.jsonl"), "{}\n");
  fs.writeFileSync(path.join(a, "work/files/readme.md"), "hi");
  await new Promise(r => setTimeout(r, 1100));   // files changed in the last second wait for the next checkpoint
  const sy = mk(a, sp);
  await sy.line('{"type":"result"}');
  assert.equal(await sy.checkpoint(), true);
  const stored = JSON.stringify([...sp.state.files.entries()].map(([k, v]) => [k, v.map(b => (b ? Buffer.from(b).toString("utf8") : null))]));
  assert.ok(!stored.includes(SECRET), "no credential bytes reached the space");
  assert.ok(!/credentials\.json|auth\.json/.test(stored), "no credential file name reached the space");
  assert.ok(stored.includes("readme.md") && stored.includes("abc.jsonl"), "ordinary files still sync: " + stored.slice(0, 300));
});
