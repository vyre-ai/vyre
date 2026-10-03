// Memory, as pure functions: what is visible, how facts group, forget with undo, edit, and an answer with its citations.
// A fact belongs to one space. Under a space scope, facts from another space are not read at all: that is the boundary.

/** @typedef {{ id: string, sp: string, subj: string, kind: 'person'|'project'|'space', text: string, src: { kind: string, label: string, target?: string }, by: string, when: string, used: number }} Fact */

/** @template {{ sp: string }} T @param {T[]} facts @param {string} scope */
export const visible = (facts, scope) => facts.filter((f) => scope === "all" || f.sp === scope);

/** Facts of one kind grouped by subject and space, in the order they first appear. @template {Fact} T @param {T[]} facts @param {Fact['kind']} kind */
export function group(facts, kind) {
  /** @type {Map<string, { key: string, subj: string, sp: string, facts: T[] }>} */
  const out = new Map();
  for (const f of facts) {
    if (f.kind !== kind) continue;
    const key = `${f.subj}|${f.sp}`;
    if (!out.has(key)) out.set(key, { key, subj: f.subj, sp: f.sp, facts: [] });
    /** @type {any} */ (out.get(key)).facts.push(f);
  }
  return [...out.values()];
}

/** Forget one fact. Returns the facts without it and what Undo needs. @template T @param {T[]} facts @param {string} id @returns {{ facts: T[], undo: { fact: T, index: number }|null }} */
export function forget(facts, id) {
  const index = facts.findIndex((f) => f.id === id);
  if (index < 0) return { facts, undo: null };
  return { facts: facts.filter((f) => f.id !== id), undo: { fact: facts[index], index } };
}

/** Put a forgotten fact back where it was. @template T @param {T[]} facts @param {{ fact: T, index: number }|null} undo */
export function restore(facts, undo) {
  if (!undo) return facts;
  const next = facts.slice();
  next.splice(Math.min(undo.index, next.length), 0, undo.fact);
  return next;
}

/** @template {Fact} T @param {T[]} facts @param {string} id @param {string} text */
export const edit = (facts, id, text) => facts.map((f) => (f.id === id && text.trim() ? { ...f, text: text.trim() } : f));

/** The subject a question is about: the first whose name contains the question. @param {Record<string,string>} subjects @param {string} q */
export function subjectOf(subjects, q) {
  const needle = q.trim().toLowerCase();
  if (needle.length < 2) return null;
  return Object.keys(subjects).find((k) => subjects[k].toLowerCase().includes(needle)) ?? null;
}

/**
 * Answer "what do we know about X". kind "none": nothing remembered anywhere. "boundary": something is remembered, but in a space this scope does not read.
 * "ok": the facts, numbered, each one a citation to its source.
 * @template {Fact} T @param {T[]} facts @param {Record<string,string>} subjects @param {string} q @param {string} scope
 */
export function answer(facts, subjects, q, scope) {
  const subject = subjectOf(subjects, q);
  if (!subject) return { kind: /** @type {const} */ ("none"), name: q.trim() };
  const all = facts.filter((f) => f.subj === subject);
  if (!all.length) return { kind: /** @type {const} */ ("none"), name: subjects[subject] };
  const shown = visible(all, scope);
  if (!shown.length) return { kind: /** @type {const} */ ("boundary"), name: subjects[subject] };
  return { kind: /** @type {const} */ ("ok"), subject, name: subjects[subject], items: shown.map((fact, i) => ({ n: i + 1, fact })) };
}
