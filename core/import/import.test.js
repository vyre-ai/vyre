// @ts-check
// import: discovery reads metadata only, suggests what is the person's own work, and a plan says
// exactly what an import would take. A real vyred on a temp home with fixture sessions.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call, request } from "../daemon/client.js";
import { tempHome } from "../../test/helpers.js";
import { cwdOf, notSuggested } from "./scan.js";

const DAY = 86_400_000, T0 = Date.parse("2026-06-01T08:00:00Z");

/** A session file as Claude Code writes it: a first entry with the folder, then turns. */
function session(dir, id, cwd, day, turns = 2) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = [{ type: "summary", summary: "x" }, { type: "user", cwd, sessionId: id, message: { role: "user", content: "SECRET-TURN-TEXT the intake form" } }];
  for (let i = 1; i < turns; i++) lines.push({ type: "assistant", cwd, message: { role: "assistant", content: "ok" } });
  const f = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(f, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  const t = new Date(T0 + day * DAY);
  fs.utimesSync(f, t, t);
  return f;
}

function world(t) {
  const root = tempHome(t);
  const projects = path.join(root, "claude", "projects");
  session(path.join(projects, "-home-alex-Work-harlow-site"), "11111111-0000-4000-8000-000000000001", "/home/alex/Work/harlow-site", 1);
  session(path.join(projects, "-home-alex-Work-harlow-site"), "11111111-0000-4000-8000-000000000002", "/home/alex/Work/harlow-site", 5, 6);
  session(path.join(projects, "-home-alex-Work-northwind"), "11111111-0000-4000-8000-000000000003", "/home/alex/Work/northwind", 9);
  session(path.join(projects, "-home-alex-Code-vyre-memory-iq"), "11111111-0000-4000-8000-000000000004", "/home/alex/Code/vyre-memory-iq", 12);
  session(path.join(projects, "-tmp-scratch"), "11111111-0000-4000-8000-000000000005", "/tmp/scratch", 13);
  // An archive kept by the person: one session also still in projects (counted once), one only here.
  const archive = path.join(root, "claude", "projects-archive");
  session(path.join(archive, "-home-alex-Work-harlow-site"), "11111111-0000-4000-8000-000000000001", "/home/alex/Work/harlow-site", 1);
  session(path.join(archive, "-home-alex-Work-harlow-site"), "11111111-0000-4000-8000-000000000006", "/home/alex/Work/harlow-site", 0.5);
  // A folder the person adds, with a session two levels down and a symlink that is never followed.
  const extra = path.join(root, "old-laptop");
  session(path.join(extra, "backup", "sessions"), "11111111-0000-4000-8000-000000000007", "/home/alex/Work/northwind", 20);
  fs.symlinkSync(projects, path.join(extra, "link-to-projects"));
  // A credentials folder the person points at by mistake, and a folder they excluded.
  session(path.join(root, ".ssh", "x"), "11111111-0000-4000-8000-000000000008", "/home/alex/Work/northwind", 21);
  session(path.join(projects, "-home-alex-Private"), "11111111-0000-4000-8000-000000000009", "/home/alex/Private", 22);
  fs.writeFileSync(path.join(root, "claude", "settings.json"), JSON.stringify({ cleanupPeriodDays: 90 }));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ vault: { keystore: "file" }, modules: { disable: ["learn"] }, memory: { personal: { skipCwds: ["/home/alex/Private"] } } }));
  return { root, extra };
}

test("import scan: sessions by source and folder, dev and temporary folders unticked, no turn text read", async t => {
  const { root, extra } = world(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const r = await call("import.scan", { folders: [extra, path.join(root, ".ssh")] }, { root });
  assert.ok(!r.error, JSON.stringify(r));
  const [projects, archive, added, ssh] = r.data.sources;
  assert.equal(projects.kind, "claude");
  assert.equal(projects.sessions, 4, "Vyre's own work and an excluded folder are left out before listing");
  assert.deepEqual(r.data.left_out, { vyre: 1, excluded: 1 });
  assert.equal(r.data.capped, false);
  assert.equal(r.data.claude_keeps_days, 90);
  assert.equal(ssh.sessions, 0, "a credentials folder is never walked");
  assert.doesNotMatch(JSON.stringify(r.data), /vyre-memory-iq|Private/, "a left-out folder was listed");
  assert.equal(archive.kind, "archive");
  assert.equal(archive.sessions, 1, "a session in both folders is counted once");
  assert.equal(added.kind, "folder");
  assert.equal(added.sessions, 1, "a symlink is never followed");
  const harlow = projects.folders.find(f => f.cwd === "/home/alex/Work/harlow-site");
  assert.deepEqual([harlow.sessions, harlow.suggested, harlow.from, harlow.to], [2, true, T0 + DAY, T0 + 5 * DAY]);
  assert.equal(projects.folders.find(f => f.cwd === "/tmp/scratch").why, "a temporary folder");
  assert.doesNotMatch(JSON.stringify(r.data), /SECRET-TURN-TEXT/, "a turn's text left the scan");
  // A model is never shown the person's disk.
  assert.equal((await d.registry.call("import.scan", {}, "mcp")).error?.code, "denied");

  // The plan: exactly the chosen folders, minus what was excluded.
  const p = (await call("import.plan", { include: ["/home/alex/Work"], exclude: ["/home/alex/Work/northwind"] }, { root })).data;
  assert.equal(p.sessions, 3, JSON.stringify(p));
  assert.deepEqual(p.folders, ["/home/alex/Work/harlow-site"]);
  assert.match(p.plan, /^plan_[0-9a-f]{12}$/);
  assert.ok(p.pace.fast.hours >= 1 && p.pace.gentle.days >= 1 && p.pace.turns >= 1, JSON.stringify(p.pace));
  assert.equal(p.pace.usd, undefined, "no money on the import screen");
  const whole = (await call("import.plan", { include: [extra] }, { root })).data;
  assert.equal(whole.sessions, 1, "a whole source by its path");

  // Indexing moves the counts, and the import says so within a few seconds, counts only.
  await call("recall.index", {}, { root });
  let ev = [];
  for (let i = 0; i < 40 && !ev.length; i++) { await new Promise(r => setTimeout(r, 150)); ev = (await request("GET", "/v1/events?type=import.progress", undefined, { root })).data; }
  assert.ok(ev.length, "no import.progress after indexing");
  assert.ok(ev.at(-1).payload.search.done >= 1, JSON.stringify(ev.at(-1).payload));
  assert.doesNotMatch(JSON.stringify(ev), /harlow|SECRET/i, "names or text in a progress event");
  const s = (await call("import.status", {}, { root })).data;
  assert.deepEqual(Object.keys(s).sort(), ["graph", "meaning", "personal", "search", "searchable_sessions"]);
  assert.ok(s.search.total >= s.search.done);
});

test("import scan: the folder a session ran in comes from its first lines; unknown when it is not there", t => {
  const dir = path.join(tempHome(t), "s");
  assert.equal(cwdOf(session(dir, "a", "/home/alex/Work/x", 0)), "/home/alex/Work/x");
  fs.writeFileSync(path.join(dir, "b.jsonl"), "not json\n");
  assert.equal(cwdOf(path.join(dir, "b.jsonl")), null);
  assert.equal(notSuggested(null), "the folder it ran in is unknown");
  assert.equal(notSuggested("/home/alex/.vyre/quick/memory", { quick: "/home/alex/.vyre/quick" }), "Vyre's own quick sessions");
});
