// @ts-check
// A small fictional corpus that every M1 module tests against. The world: Alex Rivera runs a
// studio (Rivera Studio). Clients: Harlow Legal (Dana Reyes) and Northwind Bakery (Sam Okafor).
// Agents: juno, kit, pax. Nothing here is real, and nothing real may be added.
//
// Two ways in:
//   writeTranscripts(dir)  Claude Code transcript files on disk, as Claude Code lays them out,
//                          for the transcripts adapter and Recall's indexer.
//   seedRecall(db)         the rows a correct Recall index holds for the same corpus, for
//                          Memory and Projects to test against without running the indexer.
// Recall's tests check that indexing writeTranscripts() produces exactly seedRecall()'s rows,
// so the two cannot drift.

import fs from "node:fs";
import path from "node:path";
import { migrate } from "../../core/store/index.js";
import { MIGRATIONS } from "../../core/recall/schema.js";

export const HOME = "/home/alex";
const T0 = Date.parse("2026-09-01T09:00:00Z");
const MIN = 60_000;

/**
 * @typedef {{ role: "user"|"assistant", text: string }} Turn
 * @typedef {{ id: string, cwd: string, name?: string, human?: boolean, parent?: string, start: number, turns: Turn[] }} Session
 */

/** @type {Session[]} */
export const SESSIONS = [
  {
    id: "11111111-aaaa-4000-8000-000000000001",
    cwd: `${HOME}/Work/harlow-site`,
    name: "Harlow site rebuild",
    start: T0,
    turns: [
      { role: "user", text: "Rebuild the Harlow Legal website. Dana Reyes (dana@harlowlegal.com) wants the intake form above the fold." },
      { role: "assistant", text: "I read the repo rivera-studio/harlow-site. The intake form lives in src/intake.tsx; I'll move it into the hero on harlowlegal.com." },
      { role: "user", text: "Dana also asked for the practice areas page to list estate planning first." },
      { role: "assistant", text: "Done. Estate planning is first on /practice-areas, and the intake form now sits above the fold." },
    ],
  },
  {
    id: "11111111-aaaa-4000-8000-000000000002",
    cwd: `${HOME}/Work/harlow-intake`,
    start: T0 + 60 * MIN,
    turns: [
      { role: "user", text: "Harlow intake: route new leads from the form into their CRM and email Dana a summary each morning." },
      { role: "assistant", text: "I set up the Harlow intake route. Leads from harlowlegal.com go to the CRM, and a 7am summary goes to dana@harlowlegal.com." },
    ],
  },
  {
    id: "11111111-aaaa-4000-8000-000000000003",
    cwd: `${HOME}/Work/northwind`,
    name: "Northwind invoices",
    start: T0 + 120 * MIN,
    turns: [
      { role: "user", text: "Sam Okafor at Northwind Bakery sends invoices to billing@northwindbakery.com. Watch that inbox and file each invoice." },
      { role: "assistant", text: "I wrote a watcher, northwind-invoices, that files each invoice from billing@northwindbakery.com into the Northwind project." },
      { role: "user", text: "Sam wants a weekly total on Fridays." },
      { role: "assistant", text: "Added: every Friday at 5pm the watcher posts the week's invoice total for Northwind Bakery." },
    ],
  },
  {
    // A hub session in the parent folder that touches both clients. It belongs to no project
    // until someone picks it; nothing should file it automatically.
    id: "11111111-aaaa-4000-8000-000000000004",
    cwd: `${HOME}/Work`,
    name: "Weekly planning",
    start: T0 + 180 * MIN,
    turns: [
      { role: "user", text: "What is left this week? Harlow Legal wants the site live Friday and Northwind Bakery needs the invoice watcher checked." },
      { role: "assistant", text: "Two things: ship the Harlow site (Dana is waiting on the intake form) and confirm the Northwind invoices watcher ran for Sam." },
    ],
  },
  {
    // A subagent, run under the first session. Claude Code writes it to
    // <folder>/<parent id>/subagents/agent-<agent id>.jsonl, with the PARENT's sessionId on
    // every line and isSidechain: true. Its Vyre id is "<parent id>/agent-<agent id>".
    id: "11111111-aaaa-4000-8000-000000000001/agent-a5ub",
    cwd: `${HOME}/Work/harlow-site`,
    human: false,
    parent: "11111111-aaaa-4000-8000-000000000001",
    start: T0 + 10 * MIN,
    turns: [
      { role: "user", text: "Audit src/intake.tsx for accessibility problems and report back." },
      { role: "assistant", text: "Two problems: the email field has no label, and the submit button has no focus ring." },
    ],
  },
  {
    // A headless run (claude -p, entrypoint sdk-cli): a program started it, not a person.
    id: "11111111-aaaa-4000-8000-000000000006",
    cwd: `${HOME}/Work/northwind`,
    human: false,
    start: T0 + 240 * MIN,
    turns: [
      { role: "user", text: "Summarise this week's Northwind Bakery invoices as one line." },
      { role: "assistant", text: "Four invoices from Northwind Bakery this week, 1,240 dollars in total." },
    ],
  },
];

/** The file a session's transcript lives in, relative to the transcripts folder. */
export function relFile(s) {
  const folder = encodeCwd(s.cwd);
  if (s.parent) { const agent = s.id.split("/agent-")[1]; return path.join(folder, s.parent, "subagents", `agent-${agent}.jsonl`); }
  return path.join(folder, `${s.id}.jsonl`);
}

/** Claude Code's folder name for a working directory: every "/" and "." becomes "-". */
export const encodeCwd = cwd => cwd.replace(/[/.]/g, "-");

/** The expected rows for one session, as a correct index would hold them. */
export function expected(s) {
  const ts = s.turns.map((_, i) => s.start + i * MIN);
  return {
    session: {
      id: s.id, cwd: s.cwd, name: s.name ?? null,
      title: s.turns.find(t => t.role === "user")?.text.replace(/\s+/g, " ").slice(0, 120) ?? null,
      started: ts[0], ended: ts[ts.length - 1], turns: s.turns.length,
      human: s.human === false ? 0 : 1, parent: s.parent ?? null,
    },
    turns: s.turns.map((t, seq) => ({ session: s.id, seq, role: t.role, ts: ts[seq], text: t.text })),
  };
}

/** One transcript's JSONL lines, in the shapes Claude Code writes. */
export function lines(s) {
  const out = [];
  s.turns.forEach((t, i) => {
    const base = {
      sessionId: s.parent ?? s.id, cwd: s.cwd, timestamp: new Date(s.start + i * MIN).toISOString(),
      uuid: `${s.id.slice(-6)}-${i}`, isSidechain: Boolean(s.parent), userType: "external",
      entrypoint: s.human === false ? "sdk-cli" : "cli",
      ...(s.parent ? { agentId: s.id.split("/agent-")[1] } : {}),
    };
    if (t.role === "user") out.push({ ...base, type: "user", message: { role: "user", content: t.text } });
    else out.push({ ...base, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t.text }] } });
    // Tool traffic between turns, which the index must skip: no text of its own.
    if (t.role === "assistant" && i === 1) {
      out.push({ ...base, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: "src/intake.tsx" } }] } });
    }
  });
  // /rename writes a custom-title entry, again on every resume; the last one wins.
  if (s.name) { out.push({ type: "custom-title", customTitle: "old name", sessionId: s.id }); out.push({ type: "custom-title", customTitle: s.name, sessionId: s.id }); }
  return out;
}

/**
 * Write the corpus as transcript files under dir, laid out as ~/.claude/projects is.
 * @returns {{ dir: string, files: Record<string, string> }} files by session id
 */
export function writeTranscripts(dir, sessions = SESSIONS) {
  const files = {};
  for (const s of sessions) {
    const file = path.join(dir, relFile(s));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines(s).map(l => JSON.stringify(l)).join("\n") + "\n");
    files[s.id] = file;
  }
  return { dir, files };
}

/** Put the rows a correct Recall index holds into db, creating Recall's tables. */
export function seedRecall(db, sessions = SESSIONS, { transcripts = "/nonexistent" } = {}) {
  migrate(db, "recall", MIGRATIONS);
  const addS = db.prepare(`INSERT INTO recall_sessions (id, file, cwd, name, title, started, ended, turns, human, parent)
                           VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const addT = db.prepare("INSERT INTO recall_turns (session, seq, role, ts, text) VALUES (?,?,?,?,?)");
  for (const s of sessions) {
    const e = expected(s);
    const r = e.session;
    addS.run(r.id, path.join(transcripts, relFile(s)), r.cwd, r.name, r.title, r.started, r.ended, r.turns, r.human, r.parent);
    for (const t of e.turns) addT.run(t.session, t.seq, t.role, t.ts, t.text);
  }
}
