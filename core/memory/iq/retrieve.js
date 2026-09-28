// @ts-check
// iq/retrieve: the passages Vyre IQ reads to answer a question (ADR 0034, pipeline steps 2 and 3).
//
// No model. The question's words go to Recall (BM25, and meaning when Recall has vectors). People
// and things memory knows widen it: "my wife" also searches her name, "the northwind app" also
// searches "Northwind Bakery". Each search is one ranked list, and the lists are fused by
// reciprocal rank. A time word ("last week", "in june") favours turns from then, and fresher turns
// get a small prior. The scope is applied by Recall before anything is read: a caller that may see
// only some projects gets only their turns.
//
// Every step can be switched off (expand, when, recency, hybrid), so the evaluation measures what
// each one is worth (scripts/eval-iq.js) and a step that does not help goes.

const DAY = 86_400_000;
/** Reciprocal-rank constant for fusing the searches. */
export const FUSE_K = 20;
/** How many turns each search brings; the question's own search brings more. */
const PER_SEARCH = 30;
const PER_EXPANSION = 15;
/** At most this many expansions: each is one more search. */
const MAX_EXPAND = 4;

/** Words that carry no meaning of their own in a question. */
const STOP = new Set(("a an and are as at be been but by can could did do does done for from had has have how i i'd i'm i've im in into is it its it's " +
  "me my of on or our so than that the their them then there these they this those to us was we were what whats what's when where which " +
  "while who whom whos who's why will with would you your again ever last yesterday today week month year ago before after about any some " +
  "tell remind recall remember said say told know thing things one ones").split(" "));

/** The question's content words, in order. */
export const contentWords = (/** @type {string} */ q) => (String(q).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu) || [])
  .map(w => w.replace(/[._/-]+$/, "")).filter(w => w && !STOP.has(w));

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/**
 * The time a question points at, or null: [from, to] in ms.
 * @param {string} q @param {number} now
 */
export function timeWindow(q, now) {
  const t = String(q).toLowerCase();
  if (/\byesterday\b/.test(t)) return [now - 2 * DAY, now];
  if (/\b(?:this|last|past) week\b/.test(t)) return [now - 8 * DAY, now];
  if (/\b(?:this|last|past) month\b/.test(t)) return [now - 35 * DAY, now];
  const m = /\b(?:in|during|back in|early|late|mid)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/.exec(t);
  if (m) {
    const i = MONTHS.findIndex(x => x.startsWith(m[1]));
    const d = new Date(now);
    let y = d.getUTCFullYear();
    if (i > d.getUTCMonth()) y--;   // "in december" asked in june is last december
    return [Date.UTC(y, i, 1), Date.UTC(y, i + 1, 1)];
  }
  return null;
}

/**
 * @param {{ search: (q: any) => Promise<any[]>, personal?: any, graph?: any, askDir?: string|null, quickDir?: string|null, now?: () => number }} deps
 *   search: recall.search's hits for a query; personal and graph: what widens a question.
 */
export function retriever({ search, personal = null, graph = null, askDir = null, quickDir = null, now = () => Date.now(), next = null, picks = null }) {
  /**
   * Names memory knows that the question names: "my wife" -> "Noor", "northwind" -> "Northwind
   * Bakery". Personal names only for a caller that may see personal facts.
   * @param {string} q @param {{ personal: boolean, project_cwds: string[] }} o
   */
  const expansions = (q, o) => {
    const out = [];
    const t = String(q).toLowerCase();
    if (o.personal && personal) {
      for (const m of t.matchAll(/\b(?:my|our)\s+([a-z]+)/g)) {
        const e = personal.entity(`my ${m[1]}`) || personal.entity(m[1]);
        if (e && e.label && e.label.toLowerCase() !== m[1] && !/^(?:me|my)\b/.test(e.label)) out.push(e.label);
      }
    }
    if (graph) {
      try {
        // The graph's names for things, and their other spellings and short forms: the node's
        // label is searched too when the question used another name for it.
        const { phrases, longest } = graph.phrases("*");
        const ws = t.match(/[\p{L}\p{N}][\p{L}\p{N}'._@/-]*/gu)?.map(w => w.replace(/'s$/, "")) || [];
        for (let i = 0; i < ws.length; i++) for (let n = Math.min(longest, ws.length - i); n >= 1; n--) {
          const list = phrases.get(ws.slice(i, i + n).join(" "));
          if (!list) continue;
          for (const x of list) {
            const node = graph.node(x.node, graph.view(o.project_cwds));
            if (node && node.label && !t.includes(String(node.label).toLowerCase())) out.push(String(node.label));
          }
          break;
        }
      } catch { /* the graph not built yet: no expansion */ }
    }
    return [...new Set(out)].slice(0, MAX_EXPAND);
  };

  /**
   * @param {{ question: string, project_cwds?: string[], k?: number, personal?: boolean,
   *   expand?: boolean, when?: boolean, recency?: boolean, hybrid?: boolean, replies?: boolean, thread?: string|null, knobs?: any }} input
   *   replies: a user turn carries the assistant turn that followed it (reply)
   *   thread: the thread asked from; its turns are favoured, never the only ones
   * @returns {Promise<{ passages: { id: string, session: string, seq: number, role: string, ts: number, text: string, name: string|null, cwd: string|null, score: number, via: string[], reply?: { seq: number, text: string } }[], expanded: string[], window: [number, number]|null }>}
   */
  return async function retrieve({ question, project_cwds = [], k = 8, personal: seesPersonal = false, expand = true, when = true, recency = true, hybrid = true, replies = true, thread = null, knobs = {} }) {
    const words = contentWords(question);
    const base = words.length ? words.join(" ") : String(question);
    // A project is its folders and the sessions attached to it from elsewhere (picked threads).
    const attached = project_cwds.length && picks ? picks(project_cwds) : [];
    const scope = project_cwds.length ? { project_cwds, ...(attached.length ? { sessions: attached } : {}) } : {};
    const extra = expand ? expansions(question, { personal: seesPersonal, project_cwds }) : [];
    const queries = [{ q: base, limit: PER_SEARCH, via: "question" }, ...extra.map(x => ({ q: `${x} ${base}`, limit: PER_EXPANSION, via: `expand:${x}` }))];
    const lists = await Promise.all(queries.map(async x => ({ via: x.via, hits: await search({ q: x.q, limit: x.limit, per_session: 3, ...scope, ...(hybrid ? {} : { hybrid: false }), ...knobs }) })));
    const win = when ? timeWindow(question, now()) : null;
    const t0 = now();
    /** @type {Map<string, any>} */
    const pool = new Map();
    for (const { via, hits } of lists) {
      (hits || []).forEach((h, rank) => {
        // The Capsule's own ask threads and IQ's own model calls echo old answers: never a source.
        const cwd = h.cwd ? String(h.cwd) : "";
        if (/^Capsule: /.test(String(h.name || h.title || "")) || (askDir && cwd.startsWith(askDir)) || (quickDir && cwd.startsWith(quickDir))) return;
        const id = `${h.session}:${h.seq}`;
        const p = pool.get(id) || { id, session: String(h.session), seq: Number(h.seq), role: String(h.role), ts: Number(h.ts) || 0, text: String(h.text || h.snippet || ""),
          name: h.name ?? h.title ?? null, cwd: h.cwd ?? null, score: 0, via: [] };
        p.score += (via === "question" ? 1 : 0.6) / (FUSE_K + 1 + rank);
        p.via.push(via);
        pool.set(id, p);
      });
    }
    for (const p of pool.values()) {
      if (win && p.ts >= win[0] && p.ts < win[1]) p.score *= 1.5;
      if (thread && p.session === thread) p.score *= 1.3;
      if (recency && p.ts) p.score *= 1 + 0.15 * Math.exp(-Math.max(0, t0 - p.ts) / (60 * DAY));
    }
    // Ties break on session and seq, so the same question over the same index reads the same passages.
    const passages = [...pool.values()].sort((a, b) => b.score - a.score || a.session.localeCompare(b.session) || a.seq - b.seq).slice(0, k)
      .map(p => ({ ...p, score: Math.round(p.score * 1e5) / 1e5 }));
    // A question asked in a session is usually answered by the turn after it: a user turn carries
    // the reply that followed, so "what caused it" finds the cause, not only the question.
    if (next && replies) await Promise.all(passages.map(async p => {
      if (p.role !== "user") return;
      const r = await next(p.session, p.seq).catch(() => null);
      if (r && r.role === "assistant" && String(r.text || "").trim()) p.reply = { seq: Number(r.seq), text: String(r.text) };
    }));
    return { passages, expanded: extra, window: win };
  };
}
