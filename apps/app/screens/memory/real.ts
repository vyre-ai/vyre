// Memory against the real vyred: memory.facts to read, memory.correct to edit or forget (Undo is extras.ts uncorrectReal: one implementation of memory.uncorrect).
// A fact belongs to the person, not to a space (the personal graph), so every real fact sits in Mine.
import { callT as call } from "../../src/real/call-tool";
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

/** Edit: the old wording ended, and the person's words are true instead. */
export async function editReal(fact: string, text: string): Promise<void> {
  const r = await call("memory.correct", { fact, action: "replace", object: text });
  if (r.error) throw new Error(r.error.message);
}
