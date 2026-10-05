// @ts-check
// personal/profile: the user's durable facts as short second-person lines, for about.md and any
// surface that wants "who this is" at a glance (team/archive/work-journals/memory-iq.md, memory.profile).
//
// Only what still holds at SURE or more, and nothing sensitive: no birthdays or other dates, no
// numbers that read like an account, a phone or a street address, no health.

import { SURE } from "./answer.js";

/** Relations never shown: dates, and what only makes sense inside another line (a car's colour). */
const HIDDEN = new Set(["birthday", "color", "called", "ended:owns"]);
const PEOPLE = new Set(["spouse", "partner", "mother", "father", "child", "son", "daughter", "brother", "sister", "pet", "friend", "colleague"]);
const WORD = { spouse: "spouse", partner: "partner", mother: "mother", father: "father", child: "child", son: "son", daughter: "daughter",
  brother: "brother", sister: "sister", pet: "pet", friend: "friend", colleague: "colleague" };
const KIN_LABEL = new Set([...Object.keys(WORD), "wife", "husband", "mom", "mum", "dad", "kid", "dog", "cat"]);
/** Values a profile line must never carry. */
const SENSITIVE = [
  /\d[\d\s-]{4,}\d/,                                                     // account, card, phone numbers
  /@/,                                                                   // email addresses
  /\b\d+\s+\w+(?:\s+\w+)?\s+(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|way|court|ct)\b/i,
  /\b(?:diagnos\w*|cancer|diabet\w*|depress\w*|anxiety|adhd|hiv|pregnan\w*|therap\w*|medicat\w*|prescri\w*|surgery|illness|disease|disorder)\b/i,
  /\b(?:password|passcode|pin|ssn|social security|salary|debt|loan)\b/i,
];
/**
 * The class of a line in the person's identity memory (team/0.3/DESIGN-memory-layers.md): how they work, how they write, how they run projects, what they build with, or their life.
 * By rule, from the relation and the words: no model. The identity layer is the person's own, so these are facts about them, never about a Space's work.
 * @param {string} rel @param {string} text
 */
export function classOf(rel, text) {
  if (rel === "uses") return "stack";
  if (rel === "prefers") {
    const t = String(text).toLowerCase();
    if (/\b(?:meetings?|stand-?ups?|sprints?|kanban|deadlines?|roadmaps?|planning|plans?|async|reviews?|milestones?|tickets?|backlog|status updates?)\b/.test(t)) return "pm_style";
    if (/\b(?:writ\w*|email\w*|tone|concise|brief|short(?:er)?|bullets?|sentences?|paragraphs?|formal|casual|prose|wording|reply|replies)\b/.test(t)) return "writing_style";
    return "working_style";
  }
  return "life";
}
const article = s => (/^[aeiou]/i.test(s) ? "an " : "a ") + s;

/**
 * @param {import("./store.js").Personal} personal
 * @param {{ limit?: number, class?: string }} [opts]
 * @returns {{ facts: { text: string, kind: string, class: string, weight: number, id: string, rel: string, from: number }[] }}
 */
export function profile(personal, { limit = 12, class: only } = {}) {
  const n = Math.max(1, Math.min(50, Math.floor(Number(limit) || 12)));
  const now = f => f.current && f.confidence >= SURE;
  const one = (subj, rel) => personal.lookup({ subj, rel }).filter(now)[0] || null;
  const safe = s => !SENSITIVE.some(re => re.test(String(s)));
  const out = [], seen = new Set();
  const push = (f, text, kind, weight = f.confidence) => {
    if (seen.has(text) || !safe(text)) return;
    seen.add(text);
    out.push({ text, kind, class: classOf(f.rel, text), weight: Math.round(weight * 1000) / 1000, id: f.id, rel: f.rel, from: f.sessions });
  };
  const mine = personal.lookup({ subj: "me" }).filter(now);
  const drives = mine.find(f => f.rel === "drives") || null;
  for (const f of mine) {
    if (HIDDEN.has(f.rel)) continue;
    if (PEOPLE.has(f.rel)) {
      const nm = one(f.obj, "name");
      const label = nm ? nm.object : f.object;
      if (KIN_LABEL.has(String(label).toLowerCase())) continue;   // a relative never named says nothing
      const word = personal.called(f.obj) || WORD[f.rel] || f.rel;
      push(f, `Your ${word} is ${label}.`, "person", nm ? Math.min(f.confidence, nm.confidence) : f.confidence);
      continue;
    }
    switch (f.rel) {
      case "name": push(f, `Your name is ${f.object}.`, "person"); break;
      case "lives_in": push(f, `You live in ${f.object}.`, "place"); break;
      case "from": push(f, `You are from ${f.object}.`, "place"); break;
      case "works_at": push(f, `You work at ${f.object}.`, "work"); break;
      case "role": push(f, `You are ${article(f.object)}.`, "work"); break;
      case "client": push(f, `${f.object} is your client.`, "client"); break;
      case "uses": push(f, `You use ${f.object}.`, "other"); break;
      case "prefers": push(f, `You prefer ${f.object}.`, "preference"); break;
      case "drives": case "owns": {
        if (f.obj.startsWith("vehicle:")) {
          if (f.rel === "owns" && drives && drives.obj === f.obj) break;   // said once, as "drive"
          const col = one(f.obj, "color");
          const name = (col ? col.object + " " : "") + f.object;
          push(f, `You ${f.rel === "drives" ? "drive" : "own"} ${article(name)}.`, "vehicle");
        } else push(f, `You have ${article(f.object)}.`, "other");
        break;
      }
      default: break;
    }
  }
  out.sort((a, b) => b.weight - a.weight || b.from - a.from || a.text.localeCompare(b.text));
  return { facts: (only ? out.filter(f => f.class === only) : out).slice(0, n) };
}
