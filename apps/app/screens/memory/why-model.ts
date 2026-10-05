// The pure half of "Why do I know this": what memory.why answers for a fact, as the sources the screen lists. The turns behind a fact (grouped by thread)
// and the modules that taught it. Never a made-up source: with neither, the screen says no turn behind it is still in the index.

export type WhyTurn = { session: string; seq?: number; name?: string; text: string; role?: string; ts?: number; age?: string | null };
export type WhyTaught = { module: string; kind?: string; text?: string; at?: number };
export type Why = { fact?: { id: string } | null; turns?: WhyTurn[]; taught?: WhyTaught[]; gone?: number };

export type WhyThread = { session: string; name: string; turns: { seq: number | null; text: string; who: string; age: string }[] };
export type WhyOut = { threads: WhyThread[]; taught: { module: string; kind: string; text: string }[]; gone: string; empty: boolean };

/** Group a fact's turns by thread (in the order the box sent them), name who said each, and count what has aged out of the index. */
export function whyOf(w: Why): WhyOut {
  const turns = w.turns ?? [];
  const sessions = [...new Set(turns.map((t) => t.session))];
  const threads = sessions.map((session) => {
    const said = turns.filter((t) => t.session === session);
    return { session, name: said[0]?.name || "Untitled chat", turns: said.map((t) => ({ seq: Number.isInteger(t.seq) ? (t.seq as number) : null, text: t.text, who: t.role === "user" ? "You" : "The agent", age: t.age ?? "" })) };
  });
  const taught = (w.taught ?? []).map((t) => ({ module: t.module, kind: t.kind ?? "", text: t.text ?? "" }));
  const gone = w.gone ? `${w.gone} ${w.gone === 1 ? "turn" : "turns"} behind this ${w.gone === 1 ? "is" : "are"} no longer in the index.` : "";
  return { threads, taught, gone, empty: !turns.length && !taught.length };
}
