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

import { mayUpload } from "../../lib/drivers/credfiles.js";
test("mayUpload: of the agent home only transcripts; the work files root is untouched", () => {
  assert.equal(mayUpload("home/.claude", "home/.claude/projects/p/abc-1.jsonl"), true);
  for (const rel of ["settings.json", "settings.local.json", ".netrc", ".config/gh/hosts.yml", "plugins/x/data.json", "projects/p/notes.md", "projects/p/q/abc.jsonl", "projects/p/.credentials.json", "projects/p/auth.json"])
    assert.equal(mayUpload("home/.claude", "home/.claude/" + rel), false, rel);
  assert.equal(mayUpload("files", "files/.env"), true);
  assert.equal(mayUpload("files", "files/.mcp.json"), false);
});

test("a settings file with a key in it is not uploaded; transcripts still are", async () => {
  const sp = fakeSpace(), a = setup(), home = path.join(a, "work/home/.claude");
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: SECRET } }));
  fs.mkdirSync(path.join(home, "projects/p"), { recursive: true }); fs.writeFileSync(path.join(home, "projects/p/abc.jsonl"), "{}\n");
  await new Promise(r => setTimeout(r, 1100));
  const sy = mk(a, sp); await sy.line('{"type":"result"}');
  assert.equal(await sy.checkpoint(), true);
  const stored = JSON.stringify([...sp.state.files.entries()].map(([k, v]) => [k, v.map(b => (b ? Buffer.from(b).toString("utf8") : null))]));
  assert.ok(!stored.includes(SECRET) && !stored.includes("settings.json"));
  assert.ok(stored.includes("abc.jsonl"));
});

test("a reader that hands over a credential file anyway (a session that bent it) is refused by the runner", async () => {
  const sp = fakeSpace(), a = setup();
  const hostile = async (_req, onFile) => {
    for (const [rel, text] of [["home/.claude/.credentials.json", SECRET], ["home/.claude/settings.json", SECRET], ["home/.claude/projects/p/ok.jsonl", "{}\n"]]) {
      const bytes = Buffer.from(text); await onFile({ rel, hash: "h" + rel.length, size: bytes.length, len: bytes.length, mtimeMs: 1, bytes });
    }
    return { truncated: false };
  };
  const sy = createSessionSync({ space: sp.sync, session: "s1", work: path.join(a, "work"), state: path.join(a, "state"), reader: hostile, seal: s => s });
  await sy.line('{"type":"result"}');
  assert.equal(await sy.checkpoint(), true);
  const stored = JSON.stringify([...sp.state.files.entries()].map(([k, v]) => [k, v.map(b => (b ? Buffer.from(b).toString("utf8") : null))]));
  assert.ok(!stored.includes(SECRET), "the runner dropped what the reader should not have sent");
  assert.ok(stored.includes("ok.jsonl"));
});

test("a credential file an older build uploaded is recorded as removed (a tombstone version) at the next checkpoint", async () => {
  const sp = fakeSpace(), a = setup();
  const remote = "agent/claude/.credentials.json";
  await sp.sync.putFile("s1", remote, Buffer.from(SECRET), { base: 0 });   // the older build's upload
  fs.mkdirSync(path.join(a, "state/s1"), { recursive: true });
  fs.writeFileSync(path.join(a, "state/s1/checkpoint.json"), JSON.stringify({ seq: 0, turn: 0, manifest: { [remote]: { hash: "old", version: 1, len: SECRET.length, mtimeMs: 1 } } }));
  fs.writeFileSync(path.join(a, "work/home/.claude/.credentials.json"), SECRET);   // still on disk, still refused
  await new Promise(r => setTimeout(r, 1100));
  const sy = mk(a, sp); await sy.line('{"type":"result"}');
  assert.equal(await sy.checkpoint(), true);
  const versions = sp.state.files.get("s1|" + remote);
  assert.equal(versions.length, 2, "one tombstone version was added");
  assert.equal(versions[1], null, "the latest version of the credential file is a deletion");
  const cp = await sp.sync.getCheckpoint("s1");
  assert.equal(cp.manifest[remote].hash, "deleted");
});

test("the work folder's agent config files (which carry MCP headers and env values) are not uploaded; ordinary project files and other dotfiles still are", async () => {
  const sp = fakeSpace(), a = setup(), files = path.join(a, "work/files");
  fs.mkdirSync(path.join(files, ".claude"), { recursive: true }); fs.mkdirSync(path.join(files, ".codex"), { recursive: true }); fs.mkdirSync(path.join(files, "sub"), { recursive: true });
  fs.writeFileSync(path.join(files, ".mcp.json"), JSON.stringify({ mcpServers: { x: { headers: { authorization: "Bearer " + SECRET } } } }));
  fs.writeFileSync(path.join(files, ".claude/settings.json"), JSON.stringify({ env: { TOKEN: SECRET } }));
  fs.writeFileSync(path.join(files, ".claude/settings.local.json"), SECRET);
  fs.writeFileSync(path.join(files, ".codex/config.toml"), "token = '" + SECRET + "'");
  fs.writeFileSync(path.join(files, "sub/.mcp.json"), SECRET);
  fs.writeFileSync(path.join(files, "readme.md"), "hi"); fs.writeFileSync(path.join(files, ".gitignore"), "node_modules");
  await new Promise(r => setTimeout(r, 1100));
  const sy = mk(a, sp); await sy.line('{"type":"result"}');
  assert.equal(await sy.checkpoint(), true);
  const stored = JSON.stringify([...sp.state.files.entries()].map(([k, v]) => [k, v.map(b => (b ? Buffer.from(b).toString("utf8") : null))]));
  assert.ok(!stored.includes(SECRET), "no agent config reached the space");
  assert.ok(stored.includes("readme.md") && stored.includes(".gitignore"), "ordinary files, dotfiles included, still sync");
});
