// Memory against the real vyred: memory.facts to read, memory.correct to edit or forget, memory.uncorrect for Undo (core/memory/index.js).
// A fact belongs to the person, not to a space (the personal graph), so every real fact sits in Mine.
import { call } from "../../src/api/box";
import type { Fact } from "./data";
import { toFact, type Row } from "./real-model";

export async function loadReal(): Promise<{ facts: Fact[]; subjects: Record<string, string> }> {
  const r = await call<{ facts: Row[] }>("memory.facts", { limit: 200 });
  if (r.error) throw new Error(r.error.message);
  const rows = r.data?.facts ?? [];
  const subjects: Record<string, string> = {};
  for (const x of rows) subjects[x.subject.id] = x.subject.label;
  return { facts: rows.map(toFact), subjects };
}

/** Forget: the fact was never true. Returns the correction's id for Undo. */
export async function forgetReal(fact: string): Promise<number | null> {
  const r = await call<{ correction?: { id?: number } | number }>("memory.correct", { fact, action: "wrong" });
  if (r.error) throw new Error(r.error.message);
  const c = r.data?.correction;
  return typeof c === "number" ? c : typeof c === "object" && c && typeof c.id === "number" ? c.id : null;
}

export async function undoReal(correction: number): Promise<void> {
  const r = await call("memory.uncorrect", { id: correction });
  if (r.error) throw new Error(r.error.message);
}

/** Edit: the old wording ended, and the person's words are true instead. */
export async function editReal(fact: string, text: string): Promise<void> {
  const r = await call("memory.correct", { fact, action: "replace", object: text });
  if (r.error) throw new Error(r.error.message);
}
