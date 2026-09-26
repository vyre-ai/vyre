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
/** @typedef {{ rel: "email_of"|"works_at", a: string, b: string }} Cue */

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
 * Everything one turn contributes, in the order found. Same text, same answer.
 * @param {unknown} input
 * @returns {{ things: Thing[], cues: Cue[] }}
 */
export function extract(input) {
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
    }
  }
  return { things, cues };
}
