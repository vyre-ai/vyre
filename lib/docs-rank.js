// @ts-check
// lib/docs-rank: finding the right docs page for an intent in plain words ("send an email to a client", "why was my call refused"). No dependency, no network, deterministic: the same corpus and query give the
// same answer every time, so a ranking test can pin it. BM25 over weighted fields (the page's `when` line and title count most, then its summary and headings, then the body), plus three things that matter
// for agents: an exact tool or event name in the query (`gate.request`) is a strong match wherever the page names it, a short list of synonyms joins what people say to what the pages say, and a page from
// the caller's own set gets a small lift. Pure: any part may import it.

const STOP = new Set("a an and are as at be but by can do does for from how i if in into is it its me my no not of on one or so that the this to up was we what when where which who why will with you your should would could about need want get make use using am were is".split(" "));

/** What people say, joined to what the pages say: each key's value is extra search words. Small on purpose; the ranking tests say when to add one. */
export const SYNONYMS = {
  email: ["send", "outward", "gate", "mail", "held"], mail: ["send", "outward", "gate"], send: ["outward", "gate", "held"], post: ["outward", "gate"], pay: ["outward", "gate", "spend"], delete: ["outward", "gate"],
  approve: ["approval", "presence", "gate", "task"], approval: ["presence", "gate", "task"], permission: ["authority", "grant", "role"], permissions: ["authority", "grant", "role"],
  refused: ["denied", "authority", "grant", "not_found"], denied: ["authority", "grant", "not_found"], forbidden: ["authority", "grant"], blocked: ["authority", "grant", "held"],
  secret: ["sealed", "vault", "placeholder"], secrets: ["sealed", "vault", "placeholder"], password: ["vault", "credential"], ssn: ["sealed", "placeholder"], key: ["vault", "credential", "sealed"],
  contact: ["record", "records"], contacts: ["record", "records"], crm: ["record", "records", "twenty"], matter: ["record", "records"],
  automation: ["flow", "flows", "step"], automate: ["flow", "flows", "step"], workflow: ["flow", "flows", "step"], schedule: ["flow", "trigger"],
  api: ["connection", "connector", "service"], integrate: ["connection", "connector"], webhook: ["connection", "hooks"], stripe: ["connection", "connector"], gmail: ["connection", "connector", "mail"],
  error: ["errors", "code", "refused"], fail: ["errors", "code"], failed: ["errors", "code"], remember: ["memory", "recall", "context"], memory: ["recall", "context", "session"],
  where: ["environment", "machine", "home"], sandbox: ["environment", "limits", "computer"], browser: ["computer", "glass", "chrome"], screen: ["computer", "glass"], skill: ["skills"],
};

/** @param {string} w */
const stem = (w) => (w.length > 5 && w.endsWith("ing") ? w.slice(0, -3) : w.length > 4 && w.endsWith("ied") ? w.slice(0, -3) + "y" : w.length > 4 && w.endsWith("ed") ? w.slice(0, -2) : w.length > 4 && w.endsWith("es") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/** Words and dotted names of a text, lowercase, stop words out, each dotted name also split into its parts. @param {string} text @returns {string[]} */
export function terms(text) {
  const out = [];
  for (const raw of String(text).toLowerCase().split(/[^a-z0-9_.\-]+/)) {
    const w = raw.replace(/^[.\-_]+|[.\-_]+$/g, "");
    if (!w) continue;
    if (/[._-]/.test(w) && w.length > 2) { out.push(w); for (const part of w.split(/[._-]+/)) if (part.length > 1 && !STOP.has(part)) out.push(stem(part)); continue; }
    if (STOP.has(w) || w.length < 2) continue;
    out.push(stem(w));
  }
  return out;
}

const FIELDS = { title: 5, when: 7, summary: 2.5, headings: 2.5, body: 1 };

/**
 * An index over pages. A page is { path, title, summary, when, headings: [{ text }], body, set }.
 * @template {{ path: string, title: string, summary?: string, when?: string, headings?: { text: string }[], body: string }} P
 * @param {P[]} pages
 */
export function buildIndex(pages) {
  const docs = [], df = new Map();
  for (const page of pages) {
    /** @type {Map<string, number>} */ const tf = new Map();
    const add = (/** @type {string} */ text, /** @type {number} */ weight) => { for (const t of terms(text)) tf.set(t, (tf.get(t) || 0) + weight); };
    add(page.title, FIELDS.title); add(page.when || "", FIELDS.when); add(page.summary || "", FIELDS.summary);
    add((page.headings || []).map((h) => h.text).join(" "), FIELDS.headings); add(page.body, FIELDS.body);
    let len = 0; for (const v of tf.values()) len += v;
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    docs.push({ page, tf, len, names: new Set(String(page.body).toLowerCase().match(/[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_-]*)+/g) || []) });
  }
  const avg = docs.reduce((a, d) => a + d.len, 0) / (docs.length || 1);
  return { docs, df, avg };
}

/**
 * The best pages for a query, best first. `prefer` names the set whose pages get a small lift ("agent" for an agent's own question).
 * @template {{ path: string, set?: string }} P
 * @param {ReturnType<typeof buildIndex>} index @param {string} query @param {{ limit?: number, prefer?: string, demote?: RegExp, lift?: number }} [o]
 * @returns {{ page: any, score: number }[]}
 */
export function search(index, query, o = {}) {
  const limit = o.limit ?? 5, k1 = 1.4, b = 0.7;
  const base = terms(query);
  if (!base.length) return [];
  const q = new Map();
  for (const t of base) q.set(t, (q.get(t) || 0) + 1);
  for (const w of String(query).toLowerCase().split(/[^a-z0-9]+/)) for (const s of SYNONYMS[/** @type {keyof typeof SYNONYMS} */ (w)] || []) for (const t of terms(s)) if (!q.has(t)) q.set(t, 0.35);
  const names = String(query).toLowerCase().match(/[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_-]*)+/g) || [];
  const N = index.docs.length;
  const scored = index.docs.map((d) => {
    let score = 0;
    for (const [t, qw] of q) {
      const f = d.tf.get(t); if (!f) continue;
      const idf = Math.log(1 + (N - (index.df.get(t) || 0) + 0.5) / ((index.df.get(t) || 0) + 0.5));
      score += qw * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / index.avg)));
    }
    for (const n of names) if (d.names.has(n)) score += 6;
    const phrase = String(query).toLowerCase().trim();
    if (phrase.length > 6 && (`${d.page.title} ${d.page.when || ""}`).toLowerCase().includes(phrase)) score += 8;
    if (o.prefer && d.page.set === o.prefer) score *= o.lift || 1.12;
    if (o.demote && o.demote.test(d.page.path)) score *= 0.5;
    return { page: d.page, score };
  }).filter((x) => x.score > 0);
  scored.sort((a, b2) => b2.score - a.score || (a.page.path < b2.page.path ? -1 : 1));
  return scored.slice(0, limit);
}
