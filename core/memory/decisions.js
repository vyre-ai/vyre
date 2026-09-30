// @ts-check
// decisions: what the person decided, per project and topic, newest wins (plan 3.5, docs/work/iq.md task 3).
//
// Three parts, all rules first and no model:
//   readDecisions(text)  the person's typed turn in, the decisions it states out: { topic, value, ... }
//   resolve(rows)        rows of one project in time order in, each with its state (current, replaced,
//                        reverted, note) and what it replaced
//   answerFrom(q, ...)   a question in, "Now: X (since 24 Sep). Before: Y." or the history it asks for
//
// A decision comes only from the person's own words, in a session trust keeps, never from Claude's
// turns, an email, a watcher or a module (a limited writer cannot write a decision at all). An
// agent's memory.write decision is current until something newer replaces it; a person's is
// replaced only by a later decision of the person's. An agent's later word on a person's topic is
// kept beside it as a note. Replaced decisions are history, never deleted.

import { userWords, devTalk, sessionTrust } from "./personal/trust.js";

/** Bumped when the reader's rules change: every session is read again. */
export const VERSION = 1;

/**
 * The topics a decision is about, by the values people choose between. words: what a question
 * says to mean the topic; need: a question must also match this (a topic with several sides).
 * @type {Record<string, { label: string, words: string[], values: string[], need?: RegExp }>}
 */
export const TOPICS = {
  hosting: { label: "hosting", words: ["host", "hosted", "hosting", "deploy", "deployed", "deployment", "hosts"], values: ["netlify", "vercel", "fly", "fly.io", "railway", "render", "heroku", "cloudflare pages", "digitalocean"] },
  framework: { label: "framework", words: ["framework", "built", "stack", "frontend", "front end"], values: ["astro", "next.js", "nextjs", "svelte", "sveltekit", "remix", "nuxt", "gatsby", "react", "vue"] },
  cms: { label: "content", words: ["cms", "content", "edit", "edits", "editing"], values: ["sanity", "mdx", "contentful", "wordpress", "strapi"] },
  payments: { label: "payments", words: ["payment", "payments", "pay", "paid", "checkout"], values: ["stripe", "square", "paypal"] },
  database: { label: "database", words: ["db", "database", "storage", "stored", "store"], values: ["sqlite", "postgres", "postgresql", "supabase", "turso", "neon", "mysql", "planetscale", "mongodb", "firebase"] },
  email: { label: "email provider", words: ["email", "emails", "mail", "transactional"], values: ["postmark", "resend", "sendgrid", "mailgun", "ses"] },
  confirmations: { label: "order confirmations", words: ["confirmation", "confirmations", "sms", "texts"], values: [] },
  runtime: { label: "runtime", words: ["written", "runtime", "language"], values: ["node", "deno", "bun", "python", "rust"] },
  linter: { label: "linter", words: ["lint", "linter", "linting", "formatter"], values: ["eslint", "biome", "prettier"] },
  analytics: { label: "analytics", words: ["analytics", "tracking"], values: ["plausible", "posthog", "ga4", "fathom"] },
  captcha: { label: "spam protection", words: ["captcha", "spam", "bots"], values: ["turnstile", "recaptcha", "hcaptcha"] },
  slots: { label: "slot length", words: ["slot", "slots", "pickup"], values: [], need: /\b(how long|length|minutes?|min)\b/ },
  rate: { label: "hourly rate", words: ["rate", "hourly", "per hour"], values: [] },
  retention: { label: "retention", words: ["keep", "kept", "retention", "retain"], values: [] },
  invoice: { label: "invoice number format", words: ["invoice number", "invoice numbers", "numbering"], values: [] },
};

const STOP = new Set(["the", "a", "an", "our", "we", "to", "of", "for", "on", "in", "it", "is", "are", "that", "this", "and", "or", "as", "at", "by", "with", "now", "again", "still", "do", "does", "did", "what", "which", "where", "how", "who", "why", "was", "were", "be", "my", "i", "us", "use", "using", "used", "right", "rn"]);
const DISPLAY = { "next.js": "Next.js", nextjs: "Next.js", "fly.io": "Fly.io", ga4: "GA4", eslint: "ESLint", mdx: "MDX", sqlite: "SQLite", postgres: "Postgres", postgresql: "PostgreSQL", sveltekit: "SvelteKit", sms: "SMS", ses: "SES" };
const cap = v => DISPLAY[v] || v.replace(/^./, c => c.toUpperCase());
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (text, w) => new RegExp(`(^|[^a-z0-9.+#])${esc(w)}($|[^a-z0-9+#]|\\.(?![a-z0-9]))`).test(text);

/** The lexicon entries a phrase names: [{ topic, value }]. Longest value first. */
function lex(phrase) {
  const out = [];
  for (const [topic, t] of Object.entries(TOPICS)) for (const v of t.values) if (has(phrase, v)) out.push({ topic, value: v });
  // fly.io also says fly: keep the longer.
  return out.filter(a => !out.some(b => b !== a && b.topic === a.topic && b.value.includes(a.value) && b.value.length > a.value.length));
}

const QUESTION = /^(what|which|why|how|where|who|when|is|are|do|does|did|should|can|could|would|shall)\b/;
const VAL = "([a-z0-9][a-z0-9.+#/_-]*(?: [a-z0-9][a-z0-9.+#/_-]*){0,2})";
/** The rules that read a clause: a regex and what its groups mean. revert: goes back to an earlier value. */
const RULES = [
  { re: new RegExp(`\\b(?:go|going|went|move|moving|moved|switch|switching|switched|change|changing)\\s+(?:[a-z0-9' -]{0,40}?\\s)?back\\s+to\\s+${VAL}`), revert: true },
  { re: new RegExp(`\\bback to\\s+${VAL}`), revert: true },
  { re: new RegExp(`\\b(?:switch|switching|move|moving|change|changing)\\s+(?:the |our )?(?<subj>[a-z0-9' -]{1,40}?)\\s+(?:over )?to\\s+${VAL}`) },
  { re: new RegExp(`\\b(?:move|moving|migrate|migrating|switch|switching)\\s+to\\s+${VAL}`) },
  { re: new RegExp(`\\bwe(?:'ve| have)? switched to\\s+${VAL}`) },
  { re: new RegExp(`\\b(?:let'?s go|lets go|let's use|lets use|go with|going with|we'?ll use|we will use|we'?re using|we are using|we'?ll go with|pick|choose)\\s+${VAL}`) },
  { re: new RegExp(`\\b(?:deploy(?:ing)?|host(?:ing)?)(?: [a-z' ]{1,30}?)? on\\s+${VAL}`) },
  { re: new RegExp(`\\buse\\s+${VAL}\\s+instead\\b`) },
  { re: new RegExp(`\\b(?:rewriting|rewrite|writing|building|porting)\\s+[a-z0-9' -]{1,30}?\\s+in\\s+${VAL}`) },
  { re: new RegExp(`\\b(?:drop|remove|rip out|get rid of|kill)\\s+(?<subj>[a-z0-9' -]{1,40}?)(?:,\\s*(?<only>[a-z0-9]+) only)`), only: true },
];

/** A phrase cut at the words that end a value ("stripe checkout, simplest" -> "stripe checkout"). */
const trimVal = p => String(p).split(/,| so | for | because | since | now | again | instead | from | then | which /)[0].trim();

/**
 * Decisions a typed turn states.
 * @param {string} text
 * @returns {{ topic: string, label: string, value: string, display: string, revert: boolean, verb: string }[]}
 */
export function readDecisions(text) {
  const own = userWords(text);
  if (!own || devTalk(own)) return [];
  const out = [];
  const seen = new Set();
  const push = d => { const k = `${d.topic}|${d.value}`; if (!seen.has(k)) { seen.add(k); out.push(d); } };
  for (let clause of own.split(/[.;!]+(?=\s|$)|\n+/)) {
    clause = clause.trim();
    const c = clause.toLowerCase().replace(/^(?:ok|okay|so|and|wait|no|yes|yeah|right)[,:]?\s+/, "").replace(/^(?:ok|okay|so|and|wait|no|yes|yeah)[,:]?\s+/, "").trim();
    if (!c || c.length > 240) continue;
    // Numbers first: a slot length, a rate, a retention, a format.
    let m;
    if ((m = /\b(\d{1,3})\s*[- ]?min(?:ute)?s?\s+slots?\b/.exec(c))) { push({ topic: "slots", label: TOPICS.slots.label, value: `${m[1]} minutes`, display: `${m[1]} minutes`, revert: false, verb: "set" }); continue; }
    if ((m = /\brate\b[^,]*?\b(?:goes|going|went)?\s*(?:up|down)?\s*to\s+\$?(\d{2,4})\b/.exec(c))) { push({ topic: "rate", label: TOPICS.rate.label, value: m[1], display: m[1], revert: false, verb: "set" }); continue; }
    if ((m = /\binvoice numbers?\s+should be\s+(\S+)/.exec(c))) { const raw = /\binvoice numbers?\s+should be\s+(\S+)/i.exec(clause); push({ topic: "invoice", label: TOPICS.invoice.label, value: m[1], display: raw ? raw[1] : m[1], revert: false, verb: "set" }); continue; }
    if ((m = /\bwe keep\s+([a-z0-9' -]{1,40}?)\s+(\d+\s+(?:months?|days?|years?|weeks?))\b/.exec(c))) { push({ topic: "retention", label: `${m[1]} retention`, value: m[2], display: m[2], revert: false, verb: "set" }); continue; }
    if (QUESTION.test(c) || /\?\s*$/.test(clause) && !/\b(?:is fine|works)\b/.test(c)) continue;
    let hit = false;
    for (const rule of RULES) {
      const r = rule.re.exec(c);
      if (!r) continue;
      hit = true;
      const g = r.groups || {};
      if (rule.only) { push({ topic: "confirmations", label: TOPICS.confirmations.label, value: g.only, display: cap(g.only), revert: false, verb: "drop" }); break; }
      const val = trimVal(r[r.length - 1] && !g.subj ? r[r.length - 1] : r[r.length - 1]);
      const named = lex(val).sort((a, b) => val.indexOf(a.value) - val.indexOf(b.value)).filter((n, i, all) => all.findIndex(m => m.topic === n.topic) === i);
      if (named.length) for (const n of named) push({ topic: n.topic, label: TOPICS[n.topic].label, value: n.value, display: cap(n.value), revert: Boolean(rule.revert), verb: rule.revert ? "back" : "set" });
      else if (g.subj && !STOP.has(g.subj.trim())) {
        const topic = g.subj.trim().replace(/^(?:the|our) /, "");
        push({ topic, label: topic, value: val.split(" ").slice(0, 2).join(" "), display: cap(val.split(" ").slice(0, 2).join(" ")), revert: Boolean(rule.revert), verb: "set" });
      }
      break;
    }
    if (hit) continue;
    // A short clause that names one thing from a topic: "payments. stripe checkout, simplest".
    const words = c.split(/\s+/);
    const cue = /\b(?:fine|simplest|for now|instead|only|keep it|ok|good)\b/.test(c);
    if ((words.length <= 4 || (words.length <= 6 && cue)) && !/^(?:drop|remove|rip|kill|delete|without|not|no|stop|never)\b/.test(c)) {
      const named = lex(c);
      if (named.length === 1) push({ topic: named[0].topic, label: TOPICS[named[0].topic].label, value: named[0].value, display: cap(named[0].value), revert: false, verb: "pick" });
    }
  }
  return out;
}

/**
 * Each decision's state. rows: { id, project, topic, value, at, by: "person"|"agent", ... } of any
 * projects. Returns the rows with state (current|replaced|reverted|note), replaces (an id) and
 * contested (a different decision within an hour of another session's).
 * @template {{ id: string, project: string, topic: string, value: string, at: number, by: string, session?: string|null }} R
 * @param {R[]} rows
 * @returns {(R & { state: string, replaces: string|null, contested: boolean })[]}
 */
export function resolve(rows) {
  const out = [];
  const groups = new Map();
  for (const r of [...rows].sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)))) {
    const k = `${r.project}\u0000${r.topic}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const list of groups.values()) {
    /** @type {any} */ let current = null;
    const past = [];
    for (const r of list) {
      const row = { ...r, state: "current", replaces: /** @type {string|null} */ (null), contested: false };
      if (current && current.value === r.value) { out.push({ ...row, state: "note" }); continue; }
      if (current && current.by === "person" && r.by !== "person") { row.state = "note"; out.push(row); continue; }
      if (current) {
        // Within an hour, from another session, is a disagreement: both stay visible.
        if (r.at - current.at < 3_600_000 && r.session && current.session && r.session !== current.session) { row.contested = true; current.contested = true; }
        current.state = past.some(p => p.value === r.value) ? "reverted" : "replaced";
        row.replaces = current.id;
      }
      past.push(row);
      current = row;
      out.push(row);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

const day = at => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const words = s => String(s || "").toLowerCase().split(/[^a-z0-9.+#]+/).filter(w => w && !STOP.has(w));

/** The topic a question is about, if any: [{ topic, by }] where by is what it said. */
export function questionTopics(q) {
  const t = String(q).toLowerCase();
  const out = [];
  for (const [topic, def] of Object.entries(TOPICS)) {
    const byValue = def.values.find(v => has(t, v));
    const byWord = def.words.find(w => has(t, w));
    if (!byValue && !byWord) continue;
    if (def.need && !def.need.test(t)) continue;
    out.push({ topic, by: byValue || byWord, value: Boolean(byValue) });
  }
  return out;
}

/**
 * Answer a question from resolved decisions of the projects it may read.
 * @param {string} question
 * @param {(ReturnType<typeof resolve>[number] & { text: string, session?: string|null, seq?: number|null, name?: string|null })[]} rows  resolved, all in scope
 * @param {{ slug: string, name: string }[]} projects  the projects the rows are in, for "harlow"
 * @returns {{ answer: string, confidence: number, source: any, history: any[], project: string, topic: string } | null}
 */
export function answerFrom(question, rows, projects = []) {
  const q = String(question || "").toLowerCase();
  const asks = questionTopics(q);
  // Which topic: a named value wins, then a topic word; a topic no rule knows (a free-form one) by shared words.
  const topics = new Set();
  // What they asked is what they said: a named value, else the topic words. Two topics is a guess.
  // A version, an address, a date or a count is not a decision.
  if (/\b(version|address|when|how many|how much|number of|phone|price of)\b/.test(q) && !/\b(rate|hourly)\b/.test(q)) return null;
  // Nor a person, a file, a config, or the person's own life.
  if (/\b(who|whose|file|files|config|configs|migrations?|webhook|css|folder|path|repo|branch|tests?|print|i|my|me|am i)\b/.test(q)) return null;
  const named = asks.filter(a => a.value);
  for (const a of named.length ? named : asks) topics.add(a.topic);
  if (topics.size > 1) return null;
  if (!topics.size) return null;
  let pool = rows.filter(r => topics.has(r.topic));
  // Which project: the one the question names, else the only one with the topic.
  const named_ = projects.filter(p => [p.slug, p.name, ...String(p.slug).split(/[-_]/), ...String(p.name).split(/\s+/)].some(w => w.length > 3 && has(q, w.toLowerCase())));
  if (named_.length) pool = pool.filter(r => named_.some(p => p.slug === r.project));
  const inProjects = new Set(pool.map(r => r.project));
  // One project and one topic, or it is a guess: the model reads the passages instead.
  if (inProjects.size !== 1 || new Set(pool.map(r => r.topic)).size !== 1) return null;
  const project = [...inProjects][0];
  const line = pool.filter(r => r.state !== "note").sort((a, b) => a.at - b.at);
  if (!line.length) return null;
  const topic = line[0].topic;
  const src = r => ({ session: r.session ?? `write:${r.id}`, seq: r.seq ?? 0, role: "user", name: r.name ?? null, quote: String(r.text).replace(/\s+/g, " ").slice(0, 200), ts: r.at });
  const cur = line.find(r => r.state === "current") || line[line.length - 1];
  const before = line.filter(r => r.at < cur.at);
  const prev = before[before.length - 1] || null;
  const valueIn = r => q.includes(String(r.value).toLowerCase());
  const shown = r => r.display || cap(String(r.value));
  const base = { project, topic, confidence: 0.85 };
  // Why: the person's own words for the decision the question is about.
  if (/^why\b|\bwhy did\b/.test(q)) {
    const drops = /\b(drop|stop|leave|left|off|quit|abandon|ditch)\b/.test(q);
    const at = line.findLastIndex(valueIn);
    if (at < 0) return null;
    const r = drops ? line[at + 1] : line[at];
    if (!r) return null;
    return { ...base, answer: `In your words: "${String(r.text).replace(/\s+/g, " ").slice(0, 240)}"`, source: src(r), history: [] };
  }
  // History: what came before, or first.
  if (/\b(before|previously|used to|prior|formerly|earlier)\b/.test(q)) {
    if (line.length < 2) return null;
    const at = line.findLastIndex(valueIn);
    const r = at > 0 ? line[at - 1] : at === 0 ? null : prev;
    if (!r) return null;
    return { ...base, answer: `Before: ${shown(r)} (${day(r.at)}).`, source: src(r), history: [] };
  }
  if (/\b(first|originally|initial|initially|start|started|began|at first)\b/.test(q)) {
    if (line.length < 2) return null;
    const r = line[0];
    return { ...base, answer: `First: ${shown(r)} (${day(r.at)}).`, source: src(r), history: [] };
  }
  // Now, with the one before it.
  const answer = `Now: ${shown(cur)} (since ${day(cur.at)}).${prev ? ` Before: ${shown(prev)} (${day(prev.at)}).` : ""}${cur.contested ? " Two of your sessions disagreed on this within an hour." : ""}`;
  return { ...base, answer, source: src(cur), history: prev ? [src(prev)] : [] };
}

/**
 * Person decisions, read from the person's typed turns, kept in memory_decisions and read again
 * only for turns not read yet.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ projects?: () => Promise<{ slug: string, name: string, folders: string[] }[]>, trust?: () => any }} [o]
 */
export function decisionStore(db, { projects = async () => [], trust = () => ({}) } = {}) {
  const cursor = db.prepare("SELECT upto FROM memory_decisions_cursor WHERE session = ?");
  const setCursor = db.prepare("INSERT INTO memory_decisions_cursor (session, upto, v) VALUES (?,?,?) ON CONFLICT (session) DO UPDATE SET upto = excluded.upto, v = excluded.v");
  const drop = db.prepare("DELETE FROM memory_decisions WHERE session = ?");
  const ins = db.prepare("INSERT OR REPLACE INTO memory_decisions (id, session, seq, project, cwd, topic, label, value, display, statement, revert, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  const within = (f, cwd) => cwd === f || cwd.startsWith(f.endsWith("/") ? f : f + "/");
  return {
    /** Read the turns not read yet. Returns how many decisions were added. */
    async sync() {
      const list = await projects().catch(() => []);
      const slugOf = cwd => {
        let best = null;
        for (const p of list) for (const f of p.folders) if (cwd && within(f, cwd) && (!best || f.length > best.len)) best = { slug: p.slug, len: f.length };
        return best ? best.slug : null;
      };
      let added = 0;
      const sessions = /** @type {any[]} */ (db.prepare("SELECT id, cwd, name, title, human, parent, turns FROM recall_sessions").all());
      for (const s of sessions) {
        const cur = /** @type {any} */ (cursor.get(s.id));
        const from = cur && cur.v === VERSION ? Number(cur.upto) : 0;
        // A new reader version, or a transcript rewritten shorter: read the session again.
        if (cur && (cur.v !== VERSION || Number(cur.upto) > Number(s.turns))) { drop.run(s.id); }
        const start = cur && cur.v === VERSION && Number(cur.upto) <= Number(s.turns) ? from : 0;
        if (start >= Number(s.turns)) continue;
        if (!sessionTrust(s, trust()).ok) { setCursor.run(s.id, Number(s.turns), VERSION); continue; }
        const project = slugOf(String(s.cwd || ""));
        const turns = /** @type {any[]} */ (db.prepare("SELECT seq, ts, text FROM recall_turns WHERE session = ? AND seq >= ? AND role = 'user' ORDER BY seq").all(s.id, start));
        for (const t of turns) {
          for (const [i, d] of readDecisions(String(t.text)).entries()) {
            ins.run(`${s.id}:${t.seq}:${i}`, s.id, t.seq, project || "", String(s.cwd || ""), d.topic, d.label, d.value, d.display, userWords(String(t.text)).replace(/\s+/g, " ").slice(0, 400), d.revert ? 1 : 0, Number(t.ts) || 0);
            added++;
          }
        }
        setCursor.run(s.id, Number(s.turns), VERSION);
      }
      return added;
    },
    /** Every decision the person made, as rows for resolve(). */
    person() {
      return /** @type {any[]} */ (db.prepare("SELECT * FROM memory_decisions ORDER BY decided_at, id").all()).map(r => ({
        id: String(r.id), project: String(r.project), cwd: String(r.cwd), topic: String(r.topic), value: String(r.value), display: String(r.display), text: String(r.statement),
        at: Number(r.decided_at), by: "person", session: String(r.session), seq: Number(r.seq), name: null, label: String(r.label) }));
    },
  };
}
