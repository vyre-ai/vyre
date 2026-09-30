// @ts-check
// iq/ask: one question in, one cited answer out, or "I don't know yet" (ADR 0034, phase 3).
//
//   1. Fast path: memory.answer. A personal fact at SURE or more answers with no model call.
//   2. Retrieval (./retrieve.js): the 8 passages the answer is read from.
//   3. Answer: the fast model reads the question and the passages and must reply in JSON:
//      { answer, cite: [passage numbers], confidence, abstain, known: [short facts] }.
//   4. Code checks what the model cannot be trusted to: every citation is one of the passages
//      given, and every name, number, path and quoted word in the answer is in what it cites.
//      A failed check is an abstention, never a softer answer.
//
// Deterministic: the model's reply is kept by the hash of the exact prompt (memory_iq_asks), so
// the same question over the same passages is answered the same way, and CI replays the kept
// replies without calling a model. Claude Code has no temperature setting; the cache is how.

import crypto from "node:crypto";
import { userWords, devTalk } from "../personal/trust.js";

export const VERSION = 2;
/** Told as an answer from here up; under it IQ abstains with what it knows. */
export const SURE = 0.5;
/** The default daily cap on questions, in USD (config.memory.model.askDailyUsd): about 150 a day. */
export const ASK_DAILY_USD = 0.5;
/** What a surface shows when the cap is reached: never a silent failure. */
export const LIMIT_MESSAGE = "Vyre Memory has used today's share of your Claude plan. It answers again tomorrow, or give memory a bigger share in Settings.";
/** What one answer call may cost at most, in USD. */
export const MAX_USD = 0.02;

export const SYSTEM = [
  "You answer one question about the user's own work and life from numbered passages of their past sessions with Claude Code.",
  "Use only the passages. Never guess, never use outside knowledge, and never answer from a passage that only proposes something the user later rejected or reversed: the newest decision wins.",
  "Reply with JSON only, no prose: {\"answer\": string|null, \"cite\": [numbers], \"confidence\": 0..1, \"abstain\": boolean, \"known\": [short facts from the passages that bear on the question]}.",
  "Answer exactly what was asked: asked for a cause, give the cause, not the symptom; asked for a file, the file where it was fixed; asked what something was, what it turned out to be.",
  "Each passage names its project folder. A question about one project is answered only from that project's passages.",
  "answer is one short sentence that uses the passages' own words for names, files, numbers and dates. cite lists the passages it stands on.",
  "If the passages do not answer the question, set abstain true and answer null, and put what they do say that bears on it in known.",
].join("\n");

/** An answer that says who or what someone is to the user. */
const TO_USER = /\byour (?:wife|husband|partner|spouse|girlfriend|boyfriend|fiance|fiancee|mom|mum|mother|dad|father|son|daughter|kid|child|brother|sister|friend|dog|cat|pet)\b/i;

/** A passage's header as the model sees it: project folder, session name, date. */
const header = p => [p.cwd ? String(p.cwd).split("/").filter(Boolean).pop() : "unknown", String(p.name || p.session), p.ts ? new Date(p.ts).toISOString().slice(0, 10) : "unknown"];

/** A question that points at what is on the screen. */
export const POINTS = /\b(?:this|that|these|those|here|screen|looking at|in front of me|open|the (?:email|mail|message|sender|page|doc|document|pr|issue|ticket|thread|person|file|tab|window|invite|meeting))\b|\b(?:he|she|they|him|her|them|his|hers|their)\b/i;

/** The screen as plain text, capped: app, title, selection, then what is visible. @param {any} s */
export function screenText(s) {
  if (!s || typeof s !== "object") return "";
  const one = (x, n) => (typeof x === "string" ? x.replace(/\s+/g, " ").trim().slice(0, n) : "");
  return [one(s.app, 80) && `app: ${one(s.app, 80)}`, one(s.title, 200) && `title: ${one(s.title, 200)}`,
    one(s.selection, 2000) && `selected: ${one(s.selection, 2000)}`, one(s.text, 4000) && `visible: ${one(s.text, 4000)}`].filter(Boolean).join("\n");
}

/** The prompt for one question and its passages: numbered from 1, each with its session name and date. */
export function askPrompt(question, passages, view = "") {
  const fence = s => String(s).replace(/<\/?(?:passage|reply)[^>]*>/gi, "");
  const body = passages.map((p, i) => { const [project, session, date] = header(p); const said = p.reply ? `${fence(String(p.text).slice(0, 600))}\n<reply role="assistant">\n${fence(String(p.reply.text).slice(0, 1200))}\n</reply>` : fence(String(p.text).slice(0, 1500));
    return `<passage n="${i + 1}" project="${fence(project)}" session="${fence(session)}" date="${date}" role="${p.role}">\n${said}\n</passage>`; }).join("\n");
  // What is on screen only says what the question points at: it is not a passage and never a source.
  const seen = view ? `\n\n<screen note="what the user is looking at: only to understand the question; never cite it, never a fact">\n${fence(view).replace(/<\/?screen[^>]*>/gi, "")}\n</screen>` : "";
  return `${body}${seen}\n\nQuestion: ${fence(question)}`;
}

export const askHash = (/** @type {string} */ prompt) => crypto.createHash("sha256").update(`${VERSION}\u0000${SYSTEM}\u0000${prompt}`).digest("hex").slice(0, 32);

/** The model's JSON, or null. */
export function parseAsk(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || ""));
  if (!m) return null;
  try { const j = JSON.parse(m[0]); return j && typeof j === "object" ? j : null; } catch { return null; }
}

const norm = s => String(s || "").toLowerCase().replace(/[‘’`]/g, "'");
/** The words of an answer that must be in its sources: names, numbers, paths, identifiers, quoted words. */
export function mustAppear(answer) {
  const a = String(answer || "");
  const out = new Set();
  for (const m of a.matchAll(/["“]([^"”]{2,60})["”]/g)) out.add(m[1]);
  for (const sentence of a.split(/(?<=[.!?])\s+/)) {
    const toks = sentence.split(/\s+/).map(w => w.replace(/^[("'“‘\[]+|[)"'”’\],;:!?]+$|\.$/g, "")).filter(Boolean);
    let run = [], start = -1;
    const flush = () => { if (run.length && !(start === 0 && run.length === 1)) out.add(run.join(" ")); run = []; };
    toks.forEach((w, i) => {
      // A number, a path, an identifier: a digit, a slash or underscore, or a dot or dash inside it.
      if (/\d|[/_]|\w[.-]\w/.test(w)) out.add(w);
      if (/^[A-Z][a-zA-Z'’-]+$/.test(w)) { if (!run.length) start = i; run.push(w.replace(/['’]s$/, "")); } else flush();
    });
    flush();
  }
  return [...out];
}

/**
 * Check a reply against the passages it was given. Returns the answer to give, or an abstention.
 * @param {any} reply @param {any[]} passages
 * @param {{ header?: boolean }} [o]  header: false for a personal answer: a session's name or folder
 *   is often Claude's or anyone's words, never the user's, so it proves nothing about their life
 */
export function checkAsk(reply, passages, { header: withHeader = true } = {}) {
  if (!reply || typeof reply !== "object") return { abstained: true, why: "no reply" };
  const known = Array.isArray(reply.known) ? reply.known.filter(x => typeof x === "string" && x.length <= 200).slice(0, 5) : [];
  if (reply.abstain || typeof reply.answer !== "string" || !reply.answer.trim()) return { abstained: true, known, why: "the model abstained" };
  const cite = [...new Set((Array.isArray(reply.cite) ? reply.cite : []).map(Number))];
  if (!cite.length || cite.some(n => !Number.isInteger(n) || n < 1 || n > passages.length)) return { abstained: true, known, why: "a citation is not a passage given" };
  // What the model was shown for each cited passage: its words and its header (the project folder,
  // the session's name and the date), so "it went live on 2026-06-12" stands on the passage's date.
  const text = norm(cite.map(n => passages[n - 1]).map(p => `${p.text}\n${p.reply ? `${p.reply.text}\n` : ""}${withHeader ? header(p).join("\n") : ""}`).join("\n"));
  // A name of several words stands when each of its words is there ("Friday June" in "Friday, 12 June").
  const has = w => text.includes(norm(w)) || (/^[A-Z][^\s]*(?: [A-Z][^\s]*)+$/.test(w) && w.split(" ").every(x => text.includes(norm(x))));
  const missing = mustAppear(reply.answer).filter(w => !has(w));
  if (missing.length) return { abstained: true, known, why: `not in what it cites: ${missing.slice(0, 3).join(", ")}` };
  const confidence = Math.max(0, Math.min(1, Number(reply.confidence) || 0));
  if (confidence < SURE) return { abstained: true, known, why: "not sure" };
  return { abstained: false, answer: reply.answer.trim(), confidence, cite, known };
}

/**
 * @param {{ db: import("node:sqlite").DatabaseSync, answer: (i: any) => Promise<any>, retrieve: (i: any) => Promise<any>,
 *   runner?: ((r: { system: string, prompt: string, model: string, maxUsd: number, onText?: (soFar: string) => void }) => Promise<{ text: string, usd: number }>)|null,
 *   model?: () => string, budget?: { allow: (usd: number) => boolean, charge: (usd: number) => void, why?: () => string | null },
 *   fixes?: ReturnType<typeof import("./fix.js").fixes>|null, personalQ?: (q: string) => boolean, trusted?: (session: string) => boolean,
 *   decide?: ((i: { q: string, project_cwds: string[], writes?: any }) => Promise<any>)|null }} deps
 *   decide: what the person decided (core/memory/decisions.js), tried before the model: "Now: X (since 24 Sep). Before: Y."
 *   personalQ: the question is about the user's own life; then only the user's own words, from
 *   sessions source trust keeps, may ground the answer (never Claude's turns or a reply).
 *   fixes: the person's corrections (iq/fix.js); every answer gets an answer_id they can correct.
 *   runner: null means only kept replies are used (the evaluation's replay, or no model at all).
 */
/**
 * The answer's text so far, out of a model reply that is JSON still arriving: what follows "answer": up to
 * its closing quote. Null until the answer has begun.
 * @param {string} soFar
 */
export function partialAnswer(soFar) {
  const m = /"answer"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(String(soFar));
  if (!m) return null;
  let raw = m[1];
  if (/(?:^|[^\\])(?:\\\\)*\\$/.test(raw)) raw = raw.slice(0, -1);
  try { return JSON.parse(`"${raw}"`); } catch { return raw.replace(/\\u[0-9a-fA-F]{0,3}$/, ""); }
}

/**
 * A runner's onText that hands `draft` the answer so far, at least 100 ms apart.
 * @param {(text: string) => void} draft @param {() => void} used
 */
export function drafter(draft, used) {
  let last = 0, sent = "";
  return soFar => {
    const t = partialAnswer(soFar);
    const now = Date.now();
    if (!t || t === sent || now - last < 100) return;
    last = now; sent = t; used();
    try { draft(t); } catch { /* a closed connection never fails the answer */ }
  };
}

export function asker({ db, answer, retrieve, runner = null, model = () => "haiku", budget = { allow: () => true, charge: () => {} }, fixes = null, personalQ = () => false, trusted = () => true, decide = null }) {
  const get = db.prepare("SELECT reply FROM memory_iq_asks WHERE hash = ?");
  const put = db.prepare("INSERT OR REPLACE INTO memory_iq_asks (hash, v, at, reply, usd) VALUES (?,?,?,?,?)");

  /**
   * writes: the scope of memory writes (core/memory/write.js) retrieval may add as passages.
   * @param {{ question: string, project_cwds?: string[], personal?: boolean, thread?: string|null, writes?: any,
   *   stage?: (s: "understanding"|"searching"|"reading"|"checking") => void, draft?: ((text: string) => void)|null }} input
   *   stage: told as each step starts, so a surface shows what IQ is doing (ADR 0034, stream).
   *   draft: the answer so far, for the calling connection only (never the events bus), from a streaming runner,
   *   at most every 100 ms; "" once the check fails, so the surface removes it.
   */
  return async function ask({ question, project_cwds = [], personal: sees = false, thread = null, stage = () => {}, screen = null, writes = null, draft = null }) {
    const t0 = performance.now();
    const q = String(question || "").trim();
    const done = r => {
      const out = { answer: null, confidence: 0, abstained: true, known: [], sources: [], via: null, cost_usd: 0, ...r, latency_ms: Math.round(performance.now() - t0) };
      // An answer the person can correct where it appears, by this id.
      // A "not sure" has one too: the person can type the answer IQ did not have.
      if (fixes && q && out.via !== "corrected" && !out.limited) out.answer_id = fixes.issue({ question: q, answer: out.answer || "", via: out.via, facts: r.facts || [], sources: out.sources });
      delete out.facts;
      return out;
    };
    if (!q) return done({});
    stage("understanding");
    // 0. The person corrected this question's answer: their words win, at once.
    const fix = fixes ? fixes.lookup(q) : null;
    if (fix && fix.action === "replace") {
      return done({ answer: fix.text, confidence: 1, abstained: false, via: "corrected",
        sources: [{ session: `fix:${fix.id}`, seq: 0, name: "your correction", quote: String(fix.text), ts: fix.at }] });
    }
    // Said to be wrong: that answer is never given again for this question.
    const notThis = fix && fix.action === "wrong" ? fix.old : null;
    const refused = r => notThis && r.answer === notThis ? done({ via: "corrected", known: [`You said "${notThis}" is wrong.`], why: "corrected" }) : done(r);
    // 1. The fast path: a personal fact memory is sure of.
    if (sees) {
      const f = await answer({ q, project_cwds });
      if (f && f.answer && f.kind === "fact" && (f.confidence ?? 0) >= SURE && (f.facts?.length || f.sources?.length)) {
        return refused({ answer: f.answer, confidence: f.confidence, abstained: false, sources: f.sources || [], via: "fact", facts: (f.facts || []).map(x => String(x.id)) });
      }
    }
    // 1b. A decision the person made, newest wins (plan 3.5): "Now: X (since 24 Sep). Before: Y." No model.
    if (decide && !personalQ(q)) {
      const d = await decide({ q, project_cwds, writes }).catch(() => null);
      if (d && d.answer) {
        return refused({ answer: d.answer, confidence: d.confidence, abstained: false, sources: [d.source], history: d.history, via: "decision" });
      }
    }
    // 2. The passages.
    stage("searching");
    const forgotten = fixes ? fixes.forgotten() : new Set();
    // Source trust (ADR 0034): a question about the user's life is answered only from their own
    // words in sessions trust keeps. Claude's turns, a reply, injected blocks and dev talk never count.
    const mine = personalQ(q);
    // The screen (the Capsule's front app, title, selection, visible text) helps understand a
    // question that points at it ("who sent the email I'm looking at"): its names widen the search
    // and the model sees it, marked as never a source. Never for a question about the user's life,
    // never as evidence, never cited.
    const view = !mine && screen && POINTS.test(q) ? screenText(screen) : "";
    let passages = (await retrieve({ question: q, project_cwds, k: 8, personal: sees, thread, hint: view, ...(writes ? { writes } : {}) })).passages.filter(p => !forgotten.has(`${p.session}:${p.seq}`));
    if (mine) passages = passages.filter(p => p.role === "user" && trusted(p.session) && !devTalk(String(p.text)))
      .map(p => ({ ...p, reply: undefined, text: userWords(String(p.text)) })).filter(p => p.text.trim());
    if (!passages.length) return done({ via: "retrieval" });
    // 3. The answer, kept by the prompt's hash.
    const prompt = askPrompt(q, passages, view);
    const hash = askHash(prompt);
    let text = /** @type {any} */ (get.get(hash))?.reply ?? null, usd = 0, shown = false;
    // The day's cap is reached: say so, with where to change it, and never answer quietly with nothing.
    if (text == null && runner && !budget.allow(MAX_USD)) return done({ via: "retrieval", why: "daily limit", limited: true, message: (budget.why && budget.why()) || LIMIT_MESSAGE });
    if (text == null && runner) {
      stage("reading");
      try {
        const r = await runner({ system: SYSTEM, prompt, model: model(), maxUsd: MAX_USD, ...(draft ? { onText: drafter(draft, () => { shown = true; }) } : {}) });
        text = r.text; usd = r.usd || 0;
        budget.charge(usd);
        put.run(hash, VERSION, Date.now(), String(text), usd);
      } catch { text = null; }
    }
    if (text == null) return done({ via: "retrieval", known: [], why: runner ? "the model did not answer" : "no model" });
    // 4. Code checks what it said.
    stage("checking");
    let c = checkAsk(parseAsk(text), passages, { header: !mine });
    // Who someone is to the user ("your wife Jordan") is a personal fact, whatever the question:
    // it stands only on the user's own words in a session trust keeps, never on Claude's.
    if (!c.abstained && TO_USER.test(String(c.answer))) {
      const own = /** @type {number[]} */ (c.cite).map(n => passages[n - 1]).filter(p => p.role === "user" && trusted(p.session) && !devTalk(String(p.text)))
        .map(p => ({ ...p, reply: undefined, text: userWords(String(p.text)) }));
      const again = own.length ? checkAsk({ ...parseAsk(text), cite: own.map((_, i) => i + 1) }, own, { header: false }) : { abstained: true };
      if (again.abstained) c = { abstained: true, known: c.known || [], why: "who someone is to you stands only on your own words" };
    }
    if (c.abstained) { if (shown && draft) draft(""); return done({ via: "retrieval", known: c.known || [], cost_usd: usd, why: c.why }); }
    const sources = /** @type {number[]} */ (c.cite).map(n => passages[n - 1]).flatMap(p => [{ session: p.session, seq: p.seq, role: p.role, name: p.name, quote: String(p.text).replace(/\s+/g, " ").slice(0, 200), ts: p.ts || null },
      ...(p.reply ? [{ session: p.session, seq: p.reply.seq, role: "assistant", name: p.name, quote: String(p.reply.text).replace(/\s+/g, " ").slice(0, 200), ts: p.ts || null }] : [])]);
    return refused({ answer: c.answer, confidence: c.confidence, abstained: false, known: c.known, sources, via: "retrieval", cost_usd: usd });
  };
}
