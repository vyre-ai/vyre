// The pure half of Memory's real source: one fact from memory.facts (core/memory/graph.js fact()) as the screen's Fact.
import type { Fact } from "./data";

type Node = { id: string; label: string; kind: string | null };
export type Row = { id: string; text: string; subject: Node; object: Node; confidence: number; age: string | null; seen_age?: string | null; seen?: number | null; since?: number | null; source: string | null; ref: { session: string } | null; evidence: number; taught?: { module: string }[] };

const kindOf = (k: string | null): Fact["kind"] => (k === "project" || k === "org" || k === "matter" ? "project" : k === "space" ? "space" : "person");

/** One fact from memory.facts as the screen's Fact (the shape is core/memory/graph.js fact()). */
export function toFact(r: Row): Fact {
  const taught = r.taught?.[0]?.module;
  return {
    id: r.id, sp: "mine", subj: r.subject.id, kind: kindOf(r.subject.kind), text: r.text,
    src: { kind: r.ref ? "chat" : taught ? "flow" : "record", label: r.source ?? "Vyre" },
    by: taught ?? "juno", when: r.seen_age ?? r.age ?? "", used: r.evidence, seen: Number(r.seen || r.since) || 0,
  };
}

