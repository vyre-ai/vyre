// With vault.launcherOnly on, no module holds the provider sign-in token, yet a session still signs in (the launcher takes it through the credentials port), and a module that asks is refused.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present, writeModule } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { until, FAKE } from "../sessions/testing/boot.js";

test("launcherOnly: a session still signs in through the credentials port, and a module asking for the token is refused", { timeout: 90_000 }, async t => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS, FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG };
  const transcripts = path.join(root, "transcripts"), log = path.join(root, "claude.log");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts, FAKE_CLAUDE_LOG: log });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, auth: "setup-token" }, onboard: { claude: true }, vault: { keystore: "file", launcherOnly: true } }));
  // a module that tries to read the sign-in token the way a module would
  writeModule(path.join(root, "modules"), "zz-thief", { does: { tools: [{ name: "zz-thief.take", reach: "anyone" }] }, needs: { vault: ["claude-setup-token"] } }, `
    export default { async start(ctx) { ctx.tool("zz-thief.take", { run: async () => { try { const v = await ctx.vault.fetch("claude-setup-token"); return { got: Boolean(v) }; } catch (e) { return { refused: String(e.message).slice(0, 120) }; } } }); return {}; } };`);
  const d = await start({ root, presence: present, log: () => {}, firstPartyRoots: [path.join(root, "modules")] });
  t.after(() => d.stop());
  const reg = (name, input, caller = "cli") => d.registry.call(name, input, caller);
  const TOKEN = "sk-ant-oat01-LAUNCHERONLY-aaaaaaaaaaaaaaaaaaaaaaaa";
  assert.ok((await reg("vault.provider.set", { provider: "claude", token: TOKEN })).data, "the token is stored");
  for (const m of ["threads", "agents", "zz-thief"]) assert.ok((await reg("vault.grant", { name: "claude-setup-token", module: m })).error, `${m} cannot be granted it`);
  // the vault provided the port to the registry at its own start (ctx.provide), so the launcher modules already have it
  assert.ok(d.registry.deps.credentialsPort, "the registry holds the credentials port the vault provided");
  const thief = await reg("zz-thief.take", {}, "cli");
  assert.ok(thief.data && thief.data.refused && !thief.data.got, `a module is refused: ${JSON.stringify(thief)}`);
  // a session still signs in: the fake Claude reports how it was authenticated, and the token is in no argument
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const r = await reg("threads.start", { cwd: work, prompt: "hello", surface: "deck" });
  assert.ok(r.data, JSON.stringify(r));
  await until(async () => (await reg("threads.get", { thread: r.data.id, limit: 100 })).data.events.some(e => e.type === "thread.finished"), "the turn");
  const launches = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  assert.equal(launches.at(-1).auth, "subscription", "it signed in with the setup token");
  assert.ok(!fs.readFileSync(log, "utf8").includes(TOKEN), "the token is in no log line or argument");
});
