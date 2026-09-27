// @ts-check
// personal/answer: memory.answer (docs/work/memory-iq.md). A question about the user's own life
// in, one line out: "Your wife is Jordan.", "You drive a blue Volvo XC40.", with how sure and how
// many conversations said it.
//
// Three steps, the first that answers wins:
//   1. fact     the question is parsed by rules into a relation ("name of my wife" is the name of
//               kin:spouse) and read from personal facts, or from the graph for people outside
//               the user's life ("who is Dana Reyes").
//   2. meaning  the user's own first-person statements from recall.search (hybrid when Recall has
//               vectors), filtered the way the Capsule's said.js does. A said line is never more
//               than SAID_MAX sure.
//   3. keyword  the same over keyword search only, when meaning found nothing.
// A question that maps to a relation and has no fact gets no loose quote: only a sentence that
// states that relation ("my dentist is ...") may answer it. No model calls, ever.

import { KIN, relOfRole } from "./extract.js";

/** A said line (the user's own words, turned to "you") is worth at most this. */
export const SAID_MAX = 0.45;
/** Answer from here up; say "maybe" from MAYBE; say nothing under it. */
export const SURE = 0.5;
export const MAYBE = 0.3;
/** Sources given without asking: cheap, and enough to show where it came from. */
const SOURCES = 3;
const SOURCES_ASKED = 10;
/** The graph's facts are about other people; they never read as more certain than this. */
const GRAPH_MAX = 0.9;

// ------------------------------------------------------------------ the question

/** Question and filler words: never a name, never a key noun. */
const STOP = new Set(`a an the i i'm me my mine myself we our us you your is are was were am be been do does did have has had what whats
  what's which who whom whose where when why how of to for in on at by with and or not no it its this that there here
  name named called call tell know remind please again now currently still ever any some one about like go goes going
  get got see`.split(/\s+/));

/** Words the rules read. A typo within one edit of one of these is read as it ("wfie" is "wife"). Short
 * common words ("name", "live") are left out: one edit turns too many ordinary words into them. */
const VOCAB = new Set([...Object.keys(KIN), "birthday", "bday", "vehicle", "drive", "company", "employer", "client", "clients", "contact",
  "editor", "prefer", "colour", "before", "where", "which"]);

/** Damerau-Levenshtein distance, stopping early past 1: all a typo check needs. */
function near(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return true;
  if (a.length === b.length) {
    const d = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d.push(i);
    if (d.length === 1) return true;
    return d.length === 2 && d[1] === d[0] + 1 && a[d[0]] === b[d[1]] && a[d[1]] === b[d[0]];
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < l.length; i++) if (l.slice(0, i) + l.slice(i + 1) === s) return true;
  return false;
}

/** One word, typos read as the word meant; possessives and plural typos folded ("wifes" -> "wife"). */
function fixWord(w) {
  if (!w || VOCAB.has(w) || STOP.has(w)) return w;
  if (w.endsWith("s") && KIN[w.slice(0, -1)]) return w.slice(0, -1);
  if (w.length < 4) return w;
  for (const v of VOCAB) if (v.length >= 4 && near(w, v)) return v;
  if (w.endsWith("s")) { const b = w.slice(0, -1); for (const v of Object.keys(KIN)) if (v.length >= 4 && near(b, v)) return v; }
  return w;
}

/**
 * The question in a canonical shape: lower case, contractions opened, possessives dropped,
 * typos fixed. "whats my wfie's name" -> "what is my wife name".
 * @param {string} q
 */
export function normalize(q) {
  let t = String(q || "").replace(/[‘’ʼ`´]/g, "'").toLowerCase();
  t = t.replace(/\b(who|what|where|when|how|it|that)'s\b/g, "$1 is").replace(/\bwhats\b/g, "what is").replace(/\b(?:wat|wht|waht)\b/g, "what")
    .replace(/\bi'm\b/g, "i am").replace(/\bb-day\b/g, "bday").replace(/\bfavorite\b/g, "favourite");
  t = t.replace(/[?!.,;:()"]+/g, " ").replace(/'s\b|s'(?=\s|$)/g, m => (m === "s'" ? "s" : "")).replace(/'/g, "");
  return t.split(/\s+/).filter(Boolean).map(fixWord).join(" ");
}

const KINW = Object.keys(KIN).sort((a, b) => b.length - a.length).join("|");
const KIN_RE = new RegExp(`\\b(${KINW})\\b`);

/** Nouns whose members people name without the noun: "what editor do I use" is answered by "Neovim". */
const CATEGORY = /** @type {Record<string, string[]>} */ ({
  editor: ["vim", "neovim", "nvim", "emacs", "vs code", "vscode", "visual studio code", "sublime", "zed", "helix", "intellij", "webstorm", "cursor", "nano", "xcode", "pycharm"],
  "text editor": ["vim", "neovim", "nvim", "emacs", "vs code", "vscode", "sublime", "zed", "helix", "nano"],
  ide: ["vs code", "vscode", "intellij", "webstorm", "pycharm", "xcode", "cursor", "android studio"],
  terminal: ["iterm", "iterm2", "alacritty", "kitty", "wezterm", "ghostty", "warp", "terminal"],
  shell: ["zsh", "bash", "fish", "nushell"],
  browser: ["chrome", "firefox", "safari", "arc", "brave", "edge"],
  phone: ["iphone", "pixel", "galaxy", "android", "oneplus"],
  laptop: ["macbook", "thinkpad", "xps", "surface"],
  drink: ["tea", "coffee", "water", "juice", "beer", "wine"],
});

/**
 * @typedef {{ kind: "kin", word: string, role: string }
 *   | { kind: "birthday", who: Who }
 *   | { kind: "born" }
 *   | { kind: "car", before: string|null, color: boolean }
 *   | { kind: "lives", before: string|null }
 *   | { kind: "work" }
 *   | { kind: "clients" }
 *   | { kind: "contact", org: string }
 *   | { kind: "uses", cat: string|null }
 *   | { kind: "prefers", options: string[], cat: string|null }
 *   | { kind: "owns", cat: string }
 *   | { kind: "myname" }
 *   | { kind: "who", name: string }
 *   | { kind: "attr", noun: string }} Parsed
 * @typedef {{ kin?: string, name?: string, me?: boolean }} Who
 */

/** A noun phrase with filler and leading articles taken off. */
const content = s => String(s || "").split(/\s+/).filter(w => w && !STOP.has(w)).join(" ");

/**
 * What a question asks, by rules. null: no rule knows it, so only meaning and keywords can answer.
 * @param {string} q
 * @returns {Parsed|null}
 */
export function parse(q) {
  const t = normalize(q);
  if (!t) return null;
  const kin = KIN_RE.exec(t)?.[1] || null;
  const role = kin ? KIN[kin][0] : null;
  let m;

  // Someone at an organisation: "who is my contact at Harlow Legal".
  if ((m = /\b(?:contact|person|people|who works?|who do i (?:deal|work|talk) with)\s+(?:at|from|in)\s+(.+)$/.exec(t))) return { kind: "contact", org: m[1].trim() };
  if (/\bclients?\b/.test(t) && !kin) return { kind: "clients" };
  if (/\b(?:birthday|bday)\b/.test(t) || /\bwhen (?:is|was) .*\bborn\b/.test(t)) return { kind: "birthday", who: whoOf(t, kin) };
  if (/\bwhere (?:was|were|am|are) (?:i|you) (?:born|from)\b|\bwhere do i come from\b|\bhome ?town\b|\bborn\b/.test(t)) return { kind: "born" };
  const before = (m = /\bbefore (?:the |my |i |we )*(.+)$/.exec(t)) ? content(m[1]) || "then" : /\b(?:previous|previously|used to|old|first|last)\b/.test(t) ? "then" : null;
  if (/\b(?:car|cars|vehicle|drive|driving|ride)\b/.test(t)) return { kind: "car", before, color: /\bcolou?r\b/.test(t) };
  if (/\b(?:live|lived|living|based|reside)\b/.test(t) && /\b(?:i|we|my)\b/.test(t)) return { kind: "lives", before };
  if (/\bwhere (?:do|did) i work\b|\bwho do i work for\b|\bmy (?:company|employer|studio|business|firm|agency|job|workplace)\b|\bcompany\b.*\b(?:i|my)\b/.test(t)) return { kind: "work" };
  if ((m = /\b(?:what|which) (.+?) do i use\b/.exec(t)) || (m = /\bwhat do i use for (.+)$/.exec(t))) return { kind: "uses", cat: content(m[1]) || null };
  if (/\bwhat do i use\b/.test(t)) return { kind: "uses", cat: null };
  if (/\bprefer\b/.test(t)) {
    const opts = (m = /\bprefer (.+?) or (.+)$/.exec(t)) ? [content(m[1]), content(m[2])].filter(Boolean) : [];
    return { kind: "prefers", options: opts, cat: opts.length ? null : content(t.replace(/^.*\bprefer\b/, "")) || null };
  }
  if ((m = /\bfavou?rite (.+)$/.exec(t))) return { kind: "prefers", options: [], cat: content(m[1]) || null };
  if ((m = /\b(?:what|which) (.+?) do i (?:have|own|go to|use|drink|eat)\b/.exec(t))) return { kind: kin ? "kin" : "owns", ...(kin ? { word: kin, role } : { cat: content(m[1]) }) };
  if (!kin && (/\bwhat is my name\b|\bwho am i\b|^my name$|\bmy (?:own |full )?name\b/.test(t))) return { kind: "myname" };
  if (kin && role) return { kind: "kin", word: kin, role };
  if ((m = /^(?:who|what) (?:is|was|are) (.+)$/.exec(t)) || (m = /^(?:do you know|tell me about) (.+)$/.exec(t))) {
    const x = m[1].trim();
    if (/^(?:my|our) /.test(x)) return { kind: "attr", noun: content(x) };
    if (content(x)) return { kind: "who", name: x.replace(/^(?:the|a|an) /, "") };
  }
  if ((m = /\b(?:my|our) ([a-z][a-z ]*)$/.exec(t))) return { kind: "attr", noun: content(m[1]) };
  return null;
}

/** Whose birthday: a relative's, a name's, or the user's own. */
function whoOf(t, kin) {
  if (kin) return { kin };
  const rest = t.replace(/\b(?:birthday|bday|born|when|is|was|what|the|date|of|day)\b/g, " ");
  const name = content(rest.replace(/\b(?:my|i)\b/g, " "));
  if (name) return { name };
  return { me: true };
}

// ------------------------------------------------------------------ the answer

/**
 * @typedef {import("./store.js").Fact} Fact
 * @typedef {{ answer: string|null, confidence: number|null, kind: "fact"|"said"|null, from: number, facts: any[],
 *   sources: { session: string, seq: number, name: string|null, quote: string, ts: number|null }[], via: "fact"|"meaning"|"keyword"|null, ms: number }} Answer
 */

const round = x => Math.round(x * 1000) / 1000;
const list = xs => (xs.length <= 1 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const ROLE_WORD = /** @type {Record<string, string>} */ ({ spouse: "spouse", partner: "partner", mother: "mother", father: "father", child: "child", son: "son", daughter: "daughter", brother: "brother", sister: "sister", pet: "pet", friend: "friend", colleague: "colleague" });
const PEOPLE = new Set(Object.keys(ROLE_WORD));
const KIN_LABEL = new Set([...Object.keys(KIN), ...Object.keys(ROLE_WORD)]);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasWord = (text, w) => new RegExp(`(^|[^a-z0-9])${esc(w)}($|[^a-z0-9])`, "i").test(text);

/**
 * The answerer over one store. Returns answer(input) -> Answer.
 * @param {{ personal: import("./store.js").Personal, graph?: any, db: import("node:sqlite").DatabaseSync,
 *   me?: { name?: string }|null, call?: (tool: string, input: any) => Promise<{ data?: any, error?: any }>, scratch?: string|null }} deps
 */
export function answerer({ personal, graph = null, db, me = null, call = null, scratch = null }) {
  const hasTable = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name));
  const turnQ = () => hasTable("recall_turns") ? db.prepare("SELECT text, role, ts FROM recall_turns WHERE session = ? AND seq = ?") : null;
  const sessQ = () => hasTable("recall_sessions") ? db.prepare("SELECT name, title FROM recall_sessions WHERE id = ?") : null;

  /** The sentence of a turn that names what the answer says, else its start. */
  const quoteOf = (text, keys) => {
    const s = String(text || "").replace(/\s+/g, " ").trim();
    const sentences = s.split(/(?<=[.!?])\s+/);
    const hit = sentences.find(x => keys.some(k => k && hasWord(x, k))) || sentences[0] || "";
    return hit.length > 200 ? hit.slice(0, 199).replace(/\s+\S*$/, "") + "..." : hit;
  };
  /** Where facts came from: their evidence turns, with a quote each. */
  const sourcesOf = (facts, n) => {
    const tq = turnQ(), sq = sessQ();
    const out = [], seen = new Set();
    for (const f of facts) {
      const keys = [f.object, f.subject].filter(x => x && !KIN_LABEL.has(String(x).toLowerCase()));
      for (const e of personal.evidence(f.id, n)) {
        const k = `${e.session}\u0000${e.seq}`;
        if (seen.has(k) || out.length >= n) continue;
        if (e.session.startsWith("told:")) {
          // Told to memory outright: the line itself is the source.
          const told = personal.told(e.session.slice(5));
          if (!told) continue;
          seen.add(k);
          out.push({ session: e.session, seq: e.seq, name: "told to memory", quote: quoteOf(told.text, keys), ts: told.ts });
          continue;
        }
        if (!tq) continue;
        const t = /** @type {any} */ (tq.get(e.session, e.seq));
        if (!t) continue;
        seen.add(k);
        const s = /** @type {any} */ (sq?.get(e.session));
        out.push({ session: e.session, seq: e.seq, name: s ? String(s.name || s.title || "") || null : null, quote: quoteOf(t.text, keys), ts: e.ts ?? (Number(t.ts) || null) });
      }
    }
    return out;
  };
  const factOut = f => ({ id: f.id, subject: f.subject, rel: f.rel, object: f.object, confidence: f.confidence, sessions: f.sessions, first_seen: f.first_seen, last_seen: f.last_seen });

  /**
   * One answer from facts: the line, facts behind it, how sure (the weakest fact), where from.
   * @param {string} line @param {Fact[]} facts @param {{ conf?: number }} [o]
   */
  const fromFacts = (line, facts, o = {}) => ({ line, facts, conf: o.conf ?? Math.min(...facts.map(f => f.confidence)) });

  const current = fs => fs.filter(f => f.current);
  const kinWord = (id, fallback) => personal.called(id) || fallback;
  /** Is an entity label just a kin word (the relative was never named)? */
  const unnamed = label => KIN_LABEL.has(String(label).toLowerCase());

  /** A vehicle with its colour when known: "a blue Volvo XC40". */
  const carText = (f, article = true) => {
    const col = current(personal.lookup({ subj: f.obj, rel: "color" }))[0];
    const name = (col ? col.object + " " : "") + f.object;
    return { text: article ? (/^[aeiou]/i.test(name) ? "an " : "a ") + name : name, col };
  };

  /** Personal facts for a parsed question. null: no fact answers it. */
  const byFact = (/** @type {Parsed} */ p) => {
    switch (p.kind) {
      case "kin": {
        const rel = relOfRole(p.role);
        const rels = current(personal.lookup({ subj: "me", rel }));
        const named = [];
        for (const r of rels) {
          if (unnamed(r.object)) continue;
          // A pet is the one of the species asked about: a dog is never the answer about a cat.
          if (rel === "pet" && r.obj !== `kin:${p.role}` && KIN[personal.called(r.obj) || ""]?.[0] !== p.role) continue;
          const nm = current(personal.lookup({ subj: r.obj, rel: "name" }))[0];
          named.push({ r, nm, label: nm ? nm.object : r.object });
        }
        if (!named.length) return null;
        const facts = named.flatMap(x => (x.nm ? [x.r, x.nm] : [x.r]));
        const conf = Math.min(...named.map(x => Math.min(x.r.confidence, x.nm ? x.nm.confidence : x.r.confidence)));
        const word = p.word === "kids" || p.word === "children" ? p.word : named.length > 1 ? pluralOf(p.word) : p.word;
        const line = `Your ${word} ${named.length > 1 ? "are" : "is"} ${list(named.map(x => x.label))}.`;
        return { line, facts, conf, sessions: Math.max(...named.map(x => (x.nm || x.r).sessions)) };
      }
      case "birthday": {
        const e = p.who.me ? personal.entity("me") : p.who.kin ? personal.entity(`my ${p.who.kin}`) || personal.entity(`kin:${KIN[p.who.kin][0]}`) : personal.entity(String(p.who.name));
        if (!e) return null;
        const f = current(personal.lookup({ subj: e.id, rel: "birthday" }))[0];
        if (!f) return null;
        return fromFacts(e.id === "me" ? `Your birthday is ${f.object}.` : `${unnamed(e.label) ? "Your " + e.label + "'s" : e.label + "'s"} birthday is ${f.object}.`, [f]);
      }
      case "born": {
        const f = current(personal.lookup({ subj: "me", rel: "from" }))[0];
        return f ? fromFacts(`You are from ${f.object}.`, [f]) : null;
      }
      case "car": {
        const owns = personal.lookup({ subj: "me", rel: "owns" }).filter(f => f.obj.startsWith("vehicle:"));
        const drives = personal.lookup({ subj: "me", rel: "drives" });
        if (p.before) {
          const now = current(owns).concat(current(drives));
          const was = owns.filter(f => !f.current && !now.some(n => n.obj === f.obj)).sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
          if (!was.length) return null;
          const f = was[0];
          const then = now[0] ? `Before the ${now[0].object} you had` : "You used to have";
          return fromFacts(`${then} ${carText(f).text}.`, [f, ...now.slice(0, 1)], { conf: f.confidence });
        }
        const d = current(drives)[0];
        const cur = current(owns);
        const f = d && cur.some(o => o.obj === d.obj) ? cur.find(o => o.obj === d.obj) : cur[0] || d;
        if (!f) return null;
        const c = carText(f);
        if (p.color) {
          if (!c.col) return null;
          return fromFacts(`Your ${f.object} is ${c.col.object}.`, [c.col, f], { conf: Math.min(c.col.confidence, f.confidence) });
        }
        const verb = d && d.obj === f.obj ? "drive" : "own";
        return fromFacts(`You ${verb} ${c.text}.`, [f, ...(c.col ? [c.col] : [])], { conf: f.confidence });
      }
      case "lives": {
        const all = personal.lookup({ subj: "me", rel: "lives_in" });
        const now = current(all)[0];
        if (p.before) {
          const was = all.filter(f => !f.current).sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0))[0];
          if (!was) return null;
          // A lower share is expected for a place left behind: it is known, only no longer true.
          return fromFacts(`${now ? `Before ${now.object} you lived` : "You used to live"} in ${was.object}.`, [was, ...(now ? [now] : [])],
            { conf: Math.max(was.confidence, now ? Math.min(0.9, now.confidence) : 0) });
        }
        return now ? fromFacts(`You live in ${now.object}.`, [now]) : null;
      }
      case "work": {
        const f = current(personal.lookup({ subj: "me", rel: "works_at" }))[0];
        return f ? fromFacts(`You work at ${f.object}.`, [f]) : null;
      }
      case "clients": {
        const fs = current(personal.lookup({ subj: "me", rel: "client" }));
        const names = fs.map(f => f.object);
        // The graph's clients too ("Northwind Bakery is your client"), once each.
        for (const g of graphClients()) if (!names.some(n => n.toLowerCase() === g.label.toLowerCase())) names.push(g.label);
        if (!names.length) return null;
        const conf = fs.length ? Math.min(...fs.map(f => f.confidence)) : Math.min(GRAPH_MAX, ...graphClients().map(g => g.confidence));
        return { line: names.length === 1 ? `Your client is ${names[0]}.` : `Your clients are ${list(names)}.`, facts: fs, conf };
      }
      case "uses": {
        const fs = current(personal.lookup({ subj: "me", rel: "uses" })).filter(f => inCategory(f.object, p.cat));
        if (!fs.length) return null;
        return fromFacts(`You use ${list(fs.map(f => f.object))}.`, fs);
      }
      case "prefers": {
        const fs = current(personal.lookup({ subj: "me", rel: "prefers" }))
          .filter(f => p.options.length ? p.options.some(o => hasWord(f.object, o)) : inCategory(f.object, p.cat));
        if (!fs.length) return null;
        return fromFacts(`You prefer ${fs[0].object}.`, [fs[0]]);
      }
      case "owns": {
        const fs = current(personal.lookup({ subj: "me", rel: "owns" })).filter(f => inCategory(f.object, p.cat));
        if (!fs.length) return null;
        return fromFacts(`You have ${list(fs.map(f => (/^[aeiou]/i.test(f.object) ? "an " : "a ") + f.object))}.`, fs);
      }
      case "myname": {
        const f = current(personal.lookup({ subj: "me", rel: "name" }))[0];
        if (f) return fromFacts(`Your name is ${f.object}.`, [f]);
        // Who the user is, as they set it up (config.me): known, but no conversation said it.
        if (me?.name) return { line: `Your name is ${me.name}.`, facts: [], conf: 0.9, sessions: 0 };
        return null;
      }
      case "who": {
        const e = personal.entity(p.name);
        if (!e || e.id === "me") return null;
        const links = current(personal.about(e.id)?.links || []).filter(f => f.subj === "me");
        const f = links.find(l => PEOPLE.has(l.rel)) || links[0];
        if (!f) return null;
        // The name asked about when it is one of theirs (a rival name is still theirs, less surely).
        const names = personal.lookup({ subj: e.id, rel: "name" });
        const nm = names.find(x => x.object.toLowerCase() === p.name.toLowerCase()) || current(names)[0];
        const label = nm ? nm.object : e.label;
        const role = PEOPLE.has(f.rel) ? kinWord(e.id, ROLE_WORD[f.rel]) : null;
        const line = role ? `${label} is your ${role}.`
          : f.rel === "client" ? `${label} is your client.` : f.rel === "works_at" ? `You work at ${label}.`
          : f.rel === "owns" ? `${label} is yours.` : f.rel === "uses" ? `You use ${label}.` : `${label}: ${f.rel.replace(/_/g, " ")}.`;
        return fromFacts(line.replace(/^([a-z])/, c => c.toUpperCase()), nm ? [f, nm] : [f]);
      }
      default: return null;
    }
  };

  /** The graph's clients: org nodes with a client_of edge to the user. */
  const graphClients = () => {
    if (!graph) return [];
    try {
      return /** @type {any[]} */ (db.prepare(`SELECT n.label, e.confidence FROM memory_edges e JOIN memory_nodes n ON n.id = e.src
        WHERE e.room = '*' AND e.rel = 'client_of' AND e.valid_to IS NULL`).all()).map(r => ({ label: String(r.label), confidence: Number(r.confidence) }));
    } catch { return []; }
  };
  const isClient = label => {
    const l = String(label).toLowerCase();
    return current(personal.lookup({ subj: "me", rel: "client" })).some(f => f.object.toLowerCase() === l) || graphClients().some(g => g.label.toLowerCase() === l);
  };

  /** People outside the user's life: the graph ("Dana Reyes works at Harlow Legal"). */
  const byGraph = (/** @type {Parsed} */ p) => {
    if (!graph) return null;
    if (p.kind === "contact") {
      const org = graph.resolve(p.org);
      if (!org) return null;
      const fs = graph.facts({ about: String(org.id), limit: 50 }).facts.filter(f => f.rel === "works_at" && f.object?.id === org.id);
      if (!fs.length) return null;
      const people = [...new Set(fs.map(f => String(f.subject.label)))];
      return { line: `Your contact${people.length > 1 ? "s" : ""} at ${org.label} ${people.length > 1 ? "are" : "is"} ${list(people)}.`, graphFacts: fs,
        conf: Math.min(GRAPH_MAX, ...fs.map(f => f.confidence)) };
    }
    if (p.kind === "who") {
      const n = graph.resolve(p.name);
      if (!n || !["person", "org", "name"].includes(String(n.kind))) return null;
      // A partial match only counts when every word asked is in the name found.
      const label = String(n.label).toLowerCase();
      if (!p.name.split(/\s+/).every(w => hasWord(label, w))) return null;
      const fs = graph.facts({ about: String(n.id), limit: 20 }).facts.filter(f => f.rel !== "mentioned_in" && f.subject?.id === n.id && !f.until);
      if (!fs.length) return null;
      const f = fs.find(x => x.rel === "works_at") || fs[0];
      const org = f.object?.label;
      const line = `${f.text}${f.rel === "works_at" && org && isClient(org) ? ", your client" : ""}.`;
      return { line, graphFacts: [f], conf: Math.min(GRAPH_MAX, f.confidence) };
    }
    return null;
  };

  // ---- meaning and keywords: the user's own words about themselves

  const FIRST = /^(?:i|i'm|i've|i'd|i am|my|we|we're|our)\b/i;
  const HYPO = /\b(?:if|suppose|supposing|imagine|pretend|hypothetically|assume|assuming|wish|let's say|what if|as if|for example|e\.g\.)\b/i;
  const QUESTION = /\?\s*$|^(?:who|what|which|where|when|why|how|do|does|did|is|are|was|were|can|could|should|would|will|have|has)\b/i;
  const SWAP = [[/\bI am\b/g, "you are"], [/\bI'm\b/g, "you're"], [/\bI've\b/g, "you've"], [/\bI'd\b/g, "you'd"], [/\bI was\b/g, "you were"],
    [/\bI\b/g, "you"], [/\bmyself\b/gi, "yourself"], [/\bmy\b/gi, "your"], [/\bmine\b/gi, "yours"], [/\bme\b/g, "you"], [/\bwe\b/gi, "you"], [/\bour\b/gi, "your"]];
  const toYou = s => {
    let out = s.replace(/[.!\s]+$/, "");
    for (const [re, to] of SWAP) out = out.replace(/** @type {RegExp} */ (re), /** @type {string} */ (to));
    out = cap(out);
    return out.length > 120 ? out.slice(0, 119).replace(/\s+\S*$/, "") + "..." : out + ".";
  };
  const hybridIndex = () => { try { return Boolean(db.prepare("SELECT 1 FROM recall_vectors LIMIT 1").get()); } catch { return false; } };

  /**
   * A said line from recall, or null. With a key noun (the question named a relation), only a
   * sentence that states it ("my dentist is ...") answers.
   * @param {string} q @param {string|null} noun @param {{ project_cwds?: string[] }} o
   */
  const bySaid = async (q, noun, o) => {
    if (!call) return null;
    const asked = normalize(q).split(" ").filter(w => !STOP.has(w) && w.length > 2);
    if (!asked.length && !noun) return null;
    const qf = normalize(q);
    const tries = hybridIndex() ? [{ hybrid: true, via: "meaning" }, { hybrid: false, via: "keyword" }] : [{ hybrid: false, via: "keyword" }];
    for (const t of tries) {
      const r = await call("recall.search", { q, limit: 10, per_session: 1, ...(o.project_cwds?.length ? { project_cwds: o.project_cwds } : {}), ...(t.hybrid ? {} : { hybrid: false }) });
      const hits = Array.isArray(r?.data) ? r.data : r?.data?.hits || [];
      for (const h of hits) {
        if (h.role === "assistant") continue;
        if (/^Capsule: /.test(String(h.name || h.title || "")) || (scratch && h.cwd && String(h.cwd).startsWith(scratch))) continue;
        const text = String(h.text || h.snippet || "").replace(/[«»]/g, "");
        const nt = normalize(text);
        if (qf.split(" ").length >= 3 && nt.includes(qf)) continue;   // the question itself, asked before
        for (const s of text.split(/(?<=[.!?])\s+|\n+/).map(x => x.trim())) {
          if (!FIRST.test(s) || QUESTION.test(s) || HYPO.test(s)) continue;
          const ns = normalize(s);
          if (noun) {
            if (!new RegExp(`\\bmy ${esc(noun)} (?:is|was|called|named)\\b`).test(ns)) continue;
          } else if (!asked.some(w => hasWord(ns, w))) continue;
          const session = String(h.session);
          const sn = sessQ()?.get(session);
          return { line: toYou(s), conf: Math.min(SAID_MAX, 0.4), via: t.via,
            source: { session, seq: Number(h.seq), name: sn ? String(/** @type {any} */ (sn).name || /** @type {any} */ (sn).title || "") || null : h.name || null, quote: s.length > 200 ? s.slice(0, 197) + "..." : s, ts: Number(h.ts) || null } };
        }
      }
    }
    return null;
  };

  /**
   * A line the person told memory (memory.remember) that no rule could read, found by its words:
   * newest first, the same filters as a said line.
   * @param {string} q @param {string|null} noun
   */
  const byTold = (q, noun) => {
    const asked = normalize(q).split(" ").filter(w => !STOP.has(w) && w.length > 2);
    if (!asked.length && !noun) return null;
    for (const told of personal.toldAll({ limit: 500 })) {
      for (const s of told.text.split(/(?<=[.!?])\s+/).map(x => x.trim())) {
        if (!FIRST.test(s) || QUESTION.test(s) || HYPO.test(s)) continue;
        const ns = normalize(s);
        // Told on purpose, so every word asked (any ending) is enough, as is a stated relation.
        const has = w => new RegExp(`(^|[^a-z0-9])${esc(w.replace(/(?:es|s|ed|ing)$/, "") || w)}[a-z]{0,3}($|[^a-z0-9])`).test(ns);
        const stated = noun && new RegExp(`\\bmy ${esc(noun)} (?:is|was|called|named)\\b`).test(ns);
        if (!stated && !(noun ? asked.length && asked.every(has) : asked.some(has))) continue;
        return { line: toYou(s), conf: SAID_MAX, source: { session: `told:${told.id}`, seq: 0, name: "told to memory", quote: s.length > 200 ? s.slice(0, 197) + "..." : s, ts: told.ts } };
      }
    }
    return null;
  };

  /** The key noun of a relation question, for the said filter: "son", "dentist", "phone". */
  const nounOf = (/** @type {Parsed} */ p) => {
    switch (p.kind) {
      case "kin": return p.word;
      case "attr": return p.noun || null;
      case "owns": case "uses": return p.cat || null;
      case "prefers": return p.cat ? `favourite ${p.cat}` : p.options[0] || "preference";
      case "birthday": return "birthday";
      case "born": return "birthplace";
      case "car": return "car";
      case "lives": return "home";
      case "work": return "company";
      case "clients": return "client";
      case "myname": return "name";
      case "who": return p.name;
      case "contact": return "contact";
      default: return null;
    }
  };

  /**
   * @param {{ q: string, project_cwds?: string[], sources?: boolean }} input
   * @returns {Promise<Answer>}
   */
  return async function answer({ q, project_cwds = [], sources = false }) {
    const t0 = performance.now();
    const n = sources ? SOURCES_ASKED : SOURCES;
    const done = (/** @type {Partial<Answer>} */ r) => ({ answer: null, confidence: null, kind: null, from: 0, facts: [], sources: [], via: null, ...r, ms: round(performance.now() - t0) });
    const text = String(q ?? "").trim();
    if (!text) return done({});
    const p = parse(text);
    if (p) {
      const f = byFact(p);
      if (f && f.conf >= MAYBE) {
        const conf = round(f.conf);
        const line = conf >= SURE ? f.line : "Maybe " + f.line.replace(/^(Your|You)\b/, w => w.toLowerCase());
        const from = f.sessions ?? (f.facts.length ? Math.max(...f.facts.map(x => x.sessions)) : 0);
        return done({ answer: line, confidence: conf, kind: "fact", from, facts: f.facts.map(factOut), sources: sourcesOf(f.facts, n), via: "fact" });
      }
      const g = byGraph(p);
      if (g && g.conf >= MAYBE) {
        const conf = round(g.conf);
        const src = g.graphFacts.filter(x => x.ref).slice(0, n).map(x => {
          const turn = turnQ()?.get(x.ref.session, x.ref.seq);
          return { session: x.ref.session, seq: x.ref.seq, name: x.ref.name || null, quote: turn ? quoteOf(/** @type {any} */ (turn).text, [x.subject?.label, x.object?.label]) : "", ts: x.seen || null };
        });
        return done({ answer: conf >= SURE ? g.line : "Maybe " + g.line, confidence: conf, kind: "fact", from: evidenceSessions(g.graphFacts),
          facts: g.graphFacts.map(x => ({ id: x.id, subject: x.subject?.label, rel: x.rel, object: x.object?.label, confidence: x.confidence, sessions: evidenceSessions([x]), first_seen: x.since ?? null, last_seen: x.seen ?? null })),
          sources: src, via: "fact" });
      }
    }
    // No fact. A line told to memory outright comes before anything said in passing.
    const t = byTold(text, p ? nounOf(p) : null);
    if (t) return done({ answer: t.line, confidence: round(t.conf), kind: "said", from: 1, facts: [], sources: [t.source], via: "keyword" });
    // A relation question takes only a sentence that states that relation.
    const s = await bySaid(text, p ? nounOf(p) : null, { project_cwds });
    if (s) return done({ answer: s.line, confidence: round(s.conf), kind: "said", from: 1, facts: [], sources: [s.source], via: s.via });
    return done({});
  };

  /** How many conversations support graph facts. */
  function evidenceSessions(fs) {
    try {
      const q = db.prepare(`SELECT COUNT(DISTINCT v.session) n FROM memory_evidence v JOIN memory_edges e ON e.id = v.edge
        WHERE e.room = '*' AND e.src = ? AND e.rel = ? AND e.dst = ?`);
      return Math.max(0, ...fs.map(f => { const [a, r, b] = String(f.id).split("|"); return Number(/** @type {any} */ (q.get(a, r, b))?.n || 0); }));
    } catch { return 0; }
  }
}

/** Is a value one of a category's ("Neovim" is an editor)? No category: everything is. */
function inCategory(value, cat) {
  if (!cat) return true;
  const v = String(value).toLowerCase();
  if (hasWord(v, cat) || hasWord(v, cat.replace(/s$/, ""))) return true;
  const members = CATEGORY[cat] || CATEGORY[cat.split(" ").pop() || ""] || [];
  return members.some(m => hasWord(v, m));
}

function pluralOf(w) {
  const irregular = { child: "children", wife: "wives", mom: "moms", mum: "mums" };
  return irregular[w] || (w.endsWith("s") ? w : w + "s");
}

