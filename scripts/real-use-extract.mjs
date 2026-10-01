#!/usr/bin/env node
// @ts-check
// real-use-extract: the first step of the real-use memory test (the user approved it, 1 Oct 2026, on Vyre's own sessions only).
// It READS Claude Code transcripts (.jsonl) whose cwd is under a given folder and writes a scrubbed corpus; it starts nothing, calls
// no model and sends nothing anywhere. Run it where the transcripts are; copy only its output.
//
//   node scripts/real-use-extract.mjs <projects dir> <out dir> --under <cwd folder> --deny <file> [--owner <handle>] [--max-chars 160000] [--seed 7]
//
// What is kept: the person's own typed turns, teammate messages and the assistant's text. What is dropped before anything else:
// meta messages (CLAUDE.md and memory injected at the start of every session), <system-reminder> blocks, tool results, tool inputs
// and thinking. Then the scrub, per turn: recall's redaction (lib/secret-shapes.js, the vault's shapes), emails, IPv4 addresses and
// home paths. Then the client filter: a session that names a client or a person's private matter more than twice is dropped whole,
// and a passing mention is replaced by [client]. When unsure the session is dropped (the deny file is deliberately wide: it is the caller's, one pattern a line, never committed).
// Output: corpus.json (sessions with turns), sessions-used.txt (id, date, size, a scrubbed first line) and stats.json.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { redact } from "../lib/secret-shapes.js";

/**
 * The clients, their people and private matters to keep out, one regular expression alternative per line of a file the caller holds (never
 * part of this repository): `--deny <file>`. Wide on purpose: a false hit only costs a session. @param {string[]} lines
 */
export function clientPattern(lines) {
  const alts = lines.map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if (!alts.length) throw new Error("the deny file names nothing: refusing to run with no client filter");
  return new RegExp("\\b(" + alts.join("|") + ")\\b", "gi");
}
const HOME_PATH = /\/(?:Users|home)\/[A-Za-z0-9._-]+/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const TMP_PATH = /\/private\/tmp\/claude-\d+\/[^\s`"')]*/g;
const TURN_MAX = 1500, TURN_MIN = 25;

/** Genuine text of one transcript line, or "" when the line is meta, a tool result or thinking. @param {any} j */
export function textOf(j) {
  if (!j || (j.type !== "user" && j.type !== "assistant") || j.isMeta === true || j.isSidechain === undefined && false) return "";
  const c = j.message && j.message.content;
  /** @type {string[]} */ const parts = [];
  if (typeof c === "string") parts.push(c);
  else if (Array.isArray(c)) for (const b of c) if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  let t = parts.join("\n");
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/<command-(?:name|message|args)>[\s\S]*?<\/command-(?:name|message|args)>/g, "")
    .replace(/<local-command-(?:stdout|caveat)>[\s\S]*?<\/local-command-(?:stdout|caveat)>/g, "").trim();
  if (/^(Caveat:|\[Request interrupted)/.test(t)) return "";
  return t;
}

/** The scrub applied to every kept turn. @param {string} t @param {RegExp | null} [owner] the owner's own handle, replaced by "the owner" */
export function scrub(t, owner = null) {
  const r = redact(t).replace(EMAIL, "[email]").replace(IPV4, "[ip]").replace(TMP_PATH, "/tmp/session").replace(HOME_PATH, "/home/user");
  return (owner ? r.replace(owner, "the owner") : r).slice(0, TURN_MAX);
}

/** @param {string} file @param {string} under @param {RegExp} client @param {RegExp | null} owner @returns {Promise<{ id: string, start: number, turns: { role: string, text: string }[], hits: number } | null>} */
async function readSession(file, under, client, owner) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  /** @type {{ role: string, text: string }[]} */ const turns = [];
  let inside = false, start = 0, hits = 0;
  for await (const line of rl) {
    if (!line || line.length > 4_000_000) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (typeof j.cwd === "string" && j.cwd.startsWith(under)) inside = true;
    if (!start && j.timestamp) start = Date.parse(j.timestamp) || 0;
    const raw = textOf(j);
    if (raw.length < TURN_MIN) continue;
    const m = raw.match(client);
    if (m) hits += m.length;
    const clean = scrub(raw.replace(client, "[client]"), owner);
    if (clean.length >= TURN_MIN) turns.push({ role: j.type, text: clean });
  }
  return inside && turns.length ? { id: path.basename(file, ".jsonl"), start, turns, hits } : null;
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else if (e.name.endsWith(".jsonl")) yield p;
  }
}

async function main(argv) {
  const [projects, out] = argv.filter(a => !a.startsWith("--"));
  const opt = (/** @type {string} */ k, /** @type {string} */ d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const under = opt("--under", ""), deny = opt("--deny", ""), ownerWord = opt("--owner", ""), maxChars = Number(opt("--max-chars", "160000")), seed = Number(opt("--seed", "7"));
  if (!projects || !out || !under || !deny) { console.error("usage: node scripts/real-use-extract.mjs <projects dir> <out dir> --under <cwd folder> --deny <file of client patterns> [--owner <handle>] [--max-chars n] [--seed n]"); process.exit(2); }
  const client = clientPattern(fs.readFileSync(deny, "utf8").split("\n"));
  const owner = ownerWord ? new RegExp("\\b" + ownerWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "7?\\b", "gi") : null;
  fs.mkdirSync(out, { recursive: true });
  const stats = { files: 0, inside: 0, droppedClient: 0, tooSmall: 0, eligible: 0, chosen: 0, chars: 0 };
  /** @type {any[]} */ const eligible = [];
  for (const f of walk(projects)) {
    stats.files++;
    const s = await readSession(f, under, client, owner);
    if (!s) continue;
    stats.inside++;
    const chars = s.turns.reduce((n, t) => n + t.text.length, 0);
    if (s.hits > 2) { stats.droppedClient++; continue; }
    if (chars < 3000) { stats.tooSmall++; continue; }
    eligible.push({ ...s, chars });
  }
  stats.eligible = eligible.length;
  // A seeded shuffle, then take sessions (their first 40 turns at most) until the corpus is full.
  let a = seed; const rnd = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = eligible.length - 1; i > 0; i--) { const k = Math.floor(rnd() * (i + 1)); [eligible[i], eligible[k]] = [eligible[k], eligible[i]]; }
  const chosen = []; let total = 0;
  for (const s of eligible) {
    const turns = [], cap = 12_000;
    let n = 0;
    for (const t of s.turns) { if (n + t.text.length > cap) break; turns.push(t); n += t.text.length; }
    if (n < 2500 || total + n > maxChars) continue;
    chosen.push({ id: s.id, start: s.start, turns }); total += n;
  }
  chosen.sort((x, y) => x.start - y.start);
  stats.chosen = chosen.length; stats.chars = total;
  fs.writeFileSync(path.join(out, "corpus.json"), JSON.stringify({ sessions: chosen }) + "\n");
  fs.writeFileSync(path.join(out, "sessions-used.txt"), chosen.map(s => `${s.id.slice(0, 8)}  ${new Date(s.start).toISOString().slice(0, 10)}  ${s.turns.reduce((n, t) => n + t.text.length, 0)} chars  ${s.turns[0].text.replace(/\s+/g, " ").slice(0, 90)}`).join("\n") + "\n");
  fs.writeFileSync(path.join(out, "stats.json"), JSON.stringify(stats, null, 1) + "\n");
  console.log(JSON.stringify(stats));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exit(1); });
