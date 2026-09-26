// @ts-check
// extract — what one turn names: people and organisations, email addresses, domains, repos, and
// the few phrasings that say how they relate ("Dana Reyes (dana@...)", "Sam Okafor at ...").
//
// Pure: text in, things out. No database, no clock, no model. The prototype ran this over
// 99,915 turns in 415 milliseconds, which is what lets the curator run on every new turn
// instead of in a nightly batch. Deciding what the things ARE (a person, a client, a tool, the
// user's own studio) needs the whole corpus, so that happens in the curator, not here.

import { OPENERS, HEADINGS, TOOL_WORDS, RESERVED_DOMAINS, TLDS, registrable } from "./lexicon.js";

/** @typedef {{ id: string, kind: "name"|"email"|"domain"|"repo", key: string, initial: boolean }} Thing */
/** @typedef {{ rel: "email_of"|"works_at"|"has_title"|"client_of"|"deadline"|"prefers"|"decided", a: string, b: string }} Cue */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const URL_HOST = /\bhttps?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
// A bare domain needs a known top-level domain and a first label of three or more characters,
// because code is full of dotted names ("db.run", "ctx.store") that are not places on the web.
const BARE_TLDS = TLDS.filter(t => !["me", "run", "store", "shop", "page", "site", "team", "tools", "works",
  "group", "partners", "life", "health", "care", "email", "online", "cloud", "sh", "so", "app", "dev"].includes(t));
const BARE_DOMAIN = new RegExp(`(?<![\\w@.\\/-])((?:[a-z0-9][a-z0-9-]{2,62}\\.)(?:[a-z0-9-]{1,63}\\.)*(?:${BARE_TLDS.join("|")}))(?![\\w-]|\\.[a-z0-9])`, "gi");
const REPO = [
  /\bgithub\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g,
  /\brepo(?:sitory)?\s+`?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi,
];
// A capitalised word, then up to three more joined by spaces or " & ". Spaces only: a name
// never runs across a line break, and a heading followed by a paragraph is not one name.
const WORD = "[A-Z][a-z]+(?:[A-Z][a-z]+)?(?:['’-][A-Z]?[a-z]+)?";
const RUN = new RegExp(`${WORD}(?:[ \\t]+(?:&[ \\t]+)?${WORD}){0,3}`, "g");
const SKIP_BACK = new Set([" ", "\t", "*", "_", "#", ">", '"', "'", "“", "‘", "(", "[", "`", "-"]);
const SENTENCE_END = new Set([".", "!", "?", ":", ";", "\n", "|"]);

/** Is the text at `i` the start of a sentence, a line or a list item? */
function initialAt(text, i) {
  let j = i - 1;
  while (j >= 0 && SKIP_BACK.has(text[j])) j--;
  return j < 0 || SENTENCE_END.has(text[j]);
}

const trimDot = s => s.replace(/[.,;:]+$/, "");

// A middle initial between two words: "Dana M. Reyes" is Dana Reyes.
const INITIAL = new RegExp(`\\b(${WORD})[ \\t]+[A-Z]\\.[ \\t]+(${WORD})\\b`, "g");
// An appositive title: "Dana Reyes, the office manager at Harlow Legal".
const TITLE = /^,\s+(?:the\s+|our\s+|their\s+|an?\s+)?((?:[a-z]+\s+){0,2}[a-z]+)\s+(?:at|from|of)\s+(?:the\s+)?$/;
/** Words that make an appositive a clause, not a title: "Dana Reyes, who works at ...". */
const NOT_TITLE = new Set(["works", "worked", "working", "based", "now", "currently", "also", "still", "here", "there", "who", "which", "that", "is", "was", "and", "or", "but"]);
const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const DAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const DATE = `\\d{4}-\\d{2}-\\d{2}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\b|(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|(?:${DAYS})\\b`;
// "is due 18 September", "launches on 2 October", "ships by Friday", "the deadline is Oct 2".
const DEADLINE = new RegExp(`\\b(?:is due|are due|due|deadline is|deadline|launches|ships|goes live)\\s+(?:on\\s+|by\\s+)?(${DATE})`, "gi");
const PREFERS = /\b([A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+)?)\s+prefers\s+([^.;!?\n]{2,60})/g;
const DECIDED = /\bwe\s+(?:decided|agreed)\s+to\s+([^.;!?\n]{3,160})/gi;
/** The last capitalised word before a point in a sentence, as a reference to resolve later. */
function lastCapital(text, at) {
  const from = Math.max(0, ...[".", "!", "?", "\n"].map(c => text.lastIndexOf(c, at - 1) + 1));
  const words = [...text.slice(from, at).matchAll(/\b[A-Z][a-z]+\b/g)].map(m => m[0]).filter(w => !OPENERS.has(w.toLowerCase()) && !HEADINGS.has(w.toLowerCase()));
  return words.length ? "ref:" + words[words.length - 1].toLowerCase() : null;
}

/**
 * The names in a text, with where each starts and ends. Openers and days are stripped from
 * both ends ("Actually Dana Reyes" is "Dana Reyes"); a run with a heading word or a tool in it
 * is dropped; fewer than two words left is not a name.
 */
function names(text) {
  const out = [];
  for (const m of text.matchAll(RUN)) {
    const ws = [...m[0].matchAll(/\S+/g)].map(w => ({ w: w[0], at: /** @type {number} */ (m.index) + /** @type {number} */ (w.index) }));
    let a = 0, b = ws.length;
    while (a < b && (OPENERS.has(ws[a].w.toLowerCase()) || ws[a].w === "&")) a++;
    while (b > a && (OPENERS.has(ws[b - 1].w.toLowerCase()) || ws[b - 1].w === "&")) b--;
    const kept = ws.slice(a, b);
    const real = kept.filter(x => x.w !== "&");
    if (real.length < 2) continue;
    const lower = real.map(x => x.w.toLowerCase().replace(/['’].*$/, ""));
    if (lower.some(w => HEADINGS.has(w))) continue;
    if (lower.some(w => TOOL_WORDS.has(w))) continue;
    const start = kept[0].at, last = kept[kept.length - 1];
    out.push({
      key: kept.map(x => x.w).join(" "),
      start, end: last.at + last.w.length,
      // Judged where the run began, before any opener was stripped: "Actually Seems Fine" at
      // the start of a sentence is capitalised because of where it sits, not because it is a name.
      initial: initialAt(text, ws[0].at),
    });
  }
  return out;
}

/**
 * Everything one turn contributes, in the order found. Same text, same answer. Phrasings only
 * the user's own words can make true (a client, a deadline, a preference, a decision) are read
 * from user turns only.
 * @param {unknown} input
 * @param {{ user?: boolean }} [opts]
 * @returns {{ things: Thing[], cues: Cue[] }}
 */
export function extract(input, { user = false } = {}) {
  const text = typeof input === "string" ? input : "";
  /** @type {Thing[]} */
  const things = [];
  /** @type {Cue[]} */
  const cues = [];
  if (!text) return { things, cues };

  const emails = [];
  for (const m of text.matchAll(EMAIL)) {
    const key = trimDot(m[0]).toLowerCase();
    const domain = registrable(key.split("@")[1]);
    if (RESERVED_DOMAINS.has(domain)) continue;
    emails.push({ key, start: /** @type {number} */ (m.index) });
    things.push({ id: "email:" + key, kind: "email", key, initial: false });
  }
  const hosts = [];
  for (const m of text.matchAll(URL_HOST)) hosts.push(m[1]);
  for (const m of text.matchAll(BARE_DOMAIN)) hosts.push(m[1]);
  for (const h of hosts) {
    const key = registrable(trimDot(h));
    if (!key.includes(".") || RESERVED_DOMAINS.has(key)) continue;
    things.push({ id: "domain:" + key, kind: "domain", key, initial: false });
  }
  for (const re of REPO) for (const m of text.matchAll(re)) {
    const key = `${m[1]}/${trimDot(m[2]).replace(/\.git$/, "")}`;
    if (!/[a-z]/i.test(m[1]) || !trimDot(m[2])) continue;
    things.push({ id: "repo:" + key, kind: "repo", key, initial: false });
  }

  const found = names(text);
  // "Dana M. Reyes": the run breaks at the initial, so it is read on its own, without it.
  for (const m of text.matchAll(INITIAL)) {
    const at = /** @type {number} */ (m.index);
    const first = m[1].toLowerCase(), last = m[2].toLowerCase();
    if (OPENERS.has(first) || HEADINGS.has(first) || HEADINGS.has(last) || TOOL_WORDS.has(first) || TOOL_WORDS.has(last)) continue;
    found.push({ key: `${m[1]} ${m[2]}`, start: at, end: at + m[0].length, initial: initialAt(text, at) });
  }
  found.sort((a, b) => a.start - b.start);
  for (const n of found) things.push({ id: "name:" + n.key, kind: "name", key: n.key, initial: n.initial });

  // How they relate, from the few phrasings that say it outright. Everything else about who
  // works where is decided by votes across sessions, in the curator.
  for (const n of found) {
    const after = text.slice(n.end, n.end + 80);
    const mail = after.match(/^\s*[(<]\s*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
    if (mail) {
      const key = trimDot(mail[1]).toLowerCase();
      if (emails.some(e => e.key === key)) cues.push({ rel: "email_of", a: "name:" + n.key, b: "email:" + key });
    }
  }
  for (let i = 0; i < found.length; i++) {
    for (let j = i + 1; j < found.length && j <= i + 2; j++) {
      const between = text.slice(found[i].end, found[j].start);
      // "Sam Okafor at Northwind Bakery", "Dana Reyes from Harlow Legal",
      // "Dana Reyes, the office manager at Harlow Legal".
      if (/^\s+(?:at|from)\s+(?:the\s+)?$/.test(between) || /^,\s+(?:[a-z]+\s+){1,4}(?:at|from)\s+(?:the\s+)?$/.test(between)) {
        cues.push({ rel: "works_at", a: "name:" + found[i].key, b: "name:" + found[j].key });
      }
      const title = j === i + 1 ? TITLE.exec(between) : null;
      if (title && !title[1].split(/\s+/).some(w => NOT_TITLE.has(w) || OPENERS.has(w))) cues.push({ rel: "has_title", a: "name:" + found[i].key, b: "title:" + title[1] });
    }
  }
  if (!user) return { things, cues };
  // The user's own words: "Northwind Bakery is a new client", "our new client Keel & Ash".
  for (const n of found) {
    const after = text.slice(n.end, n.end + 40), before = text.slice(Math.max(0, n.start - 40), n.start);
    if (/^\s+(?:is|are)\s+(?:now\s+)?(?:a|an|our|my)\s+(?:new\s+)?client\b/i.test(after) || /\b(?:our|my)\s+(?:new\s+)?client,?\s+$/i.test(before)) {
      cues.push({ rel: "client_of", a: "name:" + n.key, b: "me:you" });
    }
  }
  for (const m of text.matchAll(DEADLINE)) {
    const at = /** @type {number} */ (m.index);
    const sentence = Math.max(0, ...[".", "!", "?", "\n"].map(c => text.lastIndexOf(c, at - 1) + 1));
    const named = found.filter(n => n.start >= sentence && n.end <= at).pop();
    const a = named ? "name:" + named.key : lastCapital(text, at);
    if (a) cues.push({ rel: "deadline", a, b: "when:" + m[1].toLowerCase().replace(/\s+/g, " ") });
  }
  for (const m of text.matchAll(PREFERS)) {
    const n = found.find(x => x.start === m.index);
    cues.push({ rel: "prefers", a: n ? "name:" + n.key : "ref:" + m[1].toLowerCase(), b: "pref:" + trimDot(m[2].trim().toLowerCase()).slice(0, 160) });
  }
  for (const m of text.matchAll(DECIDED)) cues.push({ rel: "decided", a: "me:you", b: "decision:" + trimDot(m[1].trim()).toLowerCase().slice(0, 160) });
  return { things, cues };
}
