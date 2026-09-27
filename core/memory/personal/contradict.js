// @ts-check
// personal/contradict: two values for one thing about the person's life ("you live in Lisbon" and
// "you live in Porto"), put to them to settle, never guessed. docs/design/import.md, graph win 3.
//
// A slot that holds one value (where you live, your wife's name) has a contradiction when a rival
// value still carries real belief: at least a fifth of the winner's, said in a session of its own,
// and nothing the person told memory outright settles it already. Settling it is the person's
// own words, told to memory (memory.remember), which outweighs every older value in that slot.

import crypto from "node:crypto";

/** Slots worth asking about, with the question and the first-person answer. */
const ASK = {
  lives_in: { q: w => `Where ${w.you} live`, say: (w, v) => `${w.my} live in ${v}` },
  works_at: { q: w => `Where ${w.you} work`, say: (w, v) => `${w.my} work at ${v}` },
  role: { q: w => `What ${w.you} do for work`, say: (w, v) => `${w.am} ${/^[aeiou]/i.test(v) ? "an" : "a"} ${v}` },
  diet: { q: w => `What ${w.youEat} eat`, say: (w, v) => `${w.am} ${v}` },
  drives: { q: w => `What ${w.you} drive`, say: (w, v) => `${w.my} drive a ${v}` },
  name: { q: w => `What ${w.whose} name is`, say: (w, v) => `${w.nameOf} is ${v}` },
  from: { q: w => `Where ${w.you} come from`, say: (w, v) => `${w.my} come from ${v}` },
  birthday: { q: w => `When ${w.whose} birthday is`, say: (w, v) => `${w.birthdayOf} is ${v}` },
};
/** How much belief a rival needs, against the winner's, to be worth asking about. */
export const RIVAL = 0.2;

/** The words for the person or a relative of theirs. @param {string} subj @param {string|null} word */
function words(subj, word) {
  if (subj === "me") return { you: "do you", youEat: "do you", whose: "your", my: "I", am: "I'm", nameOf: "My name", birthdayOf: "My birthday" };
  const w = word || "relative";
  return { you: `does your ${w}`, youEat: `does your ${w}`, whose: `your ${w}'s`, my: `My ${w} does`, am: `My ${w} is`, nameOf: `My ${w}'s name`, birthdayOf: `My ${w}'s birthday` };
}

/**
 * Open contradictions about the person and the people in their life.
 * @param {import("./store.js").Personal} personal
 * @returns {{ id: string, subject: string, rel: string, question: string, values: { value: string, confidence: number, sessions: number, last_seen: number|null }[] }[]}
 */
export function contradictions(personal) {
  const db = personal.db;
  const rows = /** @type {any[]} */ (db.prepare(`SELECT * FROM memory_me_facts WHERE rel IN (${Object.keys(ASK).map(() => "?").join(",")}) ORDER BY subj, rel, confidence DESC`).all(...Object.keys(ASK)));
  /** @type {Map<string, any[]>} */
  const slots = new Map();
  for (const r of rows) { const k = `${r.subj}|${r.rel}`; if (!slots.has(k)) slots.set(k, []); slots.get(k).push(r); }
  // A slot the person already settled by telling memory: never asked again.
  const told = new Set(/** @type {any[]} */ (db.prepare("SELECT DISTINCT c.subj, c.rel FROM memory_me_claims c WHERE c.method = 'told'").all()).map(r => `${r.subj}|${r.rel}`));
  const out = [];
  for (const [k, list] of slots) {
    if (list.length < 2 || told.has(k)) continue;
    const [top, ...rest] = list;
    const rivals = rest.filter(r => Number(r.confidence) >= RIVAL * Number(top.confidence) && Number(r.sessions) >= 1 && String(r.obj_label).toLowerCase() !== String(top.obj_label).toLowerCase());
    if (!rivals.length || Number(top.confidence) <= 0) continue;
    const subj = String(top.subj), rel = String(top.rel);
    // Who it is about, in the person's own word for them ("wife"), or skip one never named.
    const word = subj === "me" ? null : personal.called(subj);
    if (subj !== "me" && !word) continue;
    const w = words(subj, word);
    const values = [top, ...rivals].slice(0, 3).map(r => ({ value: String(r.obj_label), obj: String(r.obj), confidence: Math.round(Number(r.confidence) * 1000) / 1000, sessions: Number(r.sessions), last_seen: r.last_seen == null ? null : Number(r.last_seen) }));
    const q = ASK[/** @type {keyof typeof ASK} */ (rel)];
    out.push({ id: "c_" + crypto.createHash("sha256").update(k).digest("hex").slice(0, 12), subject: subj, rel,
      question: `${q.q(w)}: ${values.map(v => v.value).join(" or ")}?`.replace(/^./, c => c.toUpperCase()), values, _say: v => q.say(w, v) });
  }
  return out;
}

/**
 * The person's answer to one: the words memory keeps ("I live in Porto") and the one claim it
 * stands for, exactly the slot and the value picked (never read again from the words).
 * @param {ReturnType<typeof contradictions>[number]} c @param {string} pick
 */
export function settle(c, pick) {
  const v = c.values.find(x => x.value.toLowerCase() === String(pick || "").trim().toLowerCase());
  if (!v) throw Object.assign(new Error(`"${pick}" is not one of ${c.values.map(x => x.value).join(", ")}`), { code: "bad_input" });
  return { text: /** @type {any} */ (c)._say(v.value), claim: { subj: c.subject, rel: c.rel, obj: v.obj } };
}
