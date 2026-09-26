// @ts-check
// perf-corpus — a synthetic, larger Claude Code transcript corpus for scripts/perf-check, in
// the style of test/fixtures/corpus.js: invented studios, clients and people, nothing real.
//
// test/fixtures/corpus.js's own SESSIONS is small on purpose (five sessions), so recall's
// correctness tests stay readable. perf-check needs Recall doing real work at rough production
// scale instead, so this generates on the order of 20,000 turns spread across many sessions and
// many project folders, written straight to disk in the same on-disk layout Claude Code uses
// (core/transcripts/index.js), so the indexer picks it up exactly like a real ~/.claude/projects.

import fs from "node:fs";
import path from "node:path";

const HOME = "/home/perfbot";
const T0 = Date.parse("2026-01-01T09:00:00Z");
const MIN = 60_000;

// Fictional only: a synthetic agency ("Loom Collective") with synthetic clients. None of this
// is real, and none of it should ever be replaced with anything real.
const CLIENTS = ["Cobalt Fixtures", "Riverstone Analytics", "Palmwood Realty", "Ferrous Metalworks",
  "Brightline Logistics", "Amberly Dental Group", "Kestrel Outfitters", "Marrow Coffee Co",
  "Thistle & Vine Events", "Granite Peak Construction"];
const TOPICS = ["the quarterly report", "the intake pipeline", "the onboarding email", "the pricing page",
  "the support macros", "the billing sync", "the referral flow", "the status dashboard",
  "the escalation policy", "the follow-up sequence"];
const PEOPLE = ["Rosa Delgado", "Theo Marchetti", "Ines Voss", "Callum Reyes", "Priya Nandan"];

function pick(arr, i) { return arr[i % arr.length]; }

/** The folder name Claude Code would give this cwd (see core/transcripts encodeCwd). */
const encodeCwd = cwd => cwd.replace(/[/.]/g, "-");

/** Deterministic pseudo-random turn text: varied enough to index and search, never real. */
function turnText(role, sIdx, tIdx) {
  const client = pick(CLIENTS, sIdx);
  const topic = pick(TOPICS, sIdx + tIdx);
  const person = pick(PEOPLE, sIdx + tIdx);
  if (role === "user") return `${person} at ${client} asked about ${topic}, turn ${tIdx}: what changed since last week and who owns the follow-up.`;
  return `Checked ${topic} for ${client}: nothing broken, ${person} is the current owner, and the next review is on Friday. (turn ${tIdx})`;
}

/**
 * Write a synthetic corpus of transcript files under dir, in Claude Code's on-disk layout.
 * @param {string} dir the transcripts root (a folder later listed in config.json's `transcripts`)
 * @param {{ sessions?: number, turnsPerSession?: number, projects?: number }} [opts]
 * @returns {{ sessions: number, turns: number }}
 */
export function writeSyntheticCorpus(dir, { sessions = 250, turnsPerSession = 80, projects = 25 } = {}) {
  let turns = 0;
  for (let s = 0; s < sessions; s++) {
    const project = s % projects;
    const cwd = `${HOME}/work/project-${project}`;
    const id = `99999999-perf-4000-8000-${String(s).padStart(12, "0")}`;
    const start = T0 + s * 30 * MIN;
    const lines = [];
    for (let i = 0; i < turnsPerSession; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      const base = {
        sessionId: id, cwd, timestamp: new Date(start + i * MIN).toISOString(),
        uuid: `${id.slice(-8)}-${i}`, isSidechain: false, userType: "external", entrypoint: "cli",
      };
      const text = turnText(role, s, i);
      if (role === "user") lines.push({ ...base, type: "user", message: { role: "user", content: text } });
      else lines.push({ ...base, type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
      turns++;
    }
    const file = path.join(dir, encodeCwd(cwd), `${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  }
  return { sessions, turns };
}
