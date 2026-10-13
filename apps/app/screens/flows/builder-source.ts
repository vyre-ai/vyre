// What the Flow builder offers to pick from, and how a finished draft is saved. A sample build answers from SAMPLE_OPTIONS and keeps Flows in memory; the real one asks the vyred
// (records.types through Customize's store, agents.list, work.template.list and get, roles.list) and saves with flows.define, which stores a version nobody has approved yet.
import { useEffect, useState } from "react";
import { allowsMock, type FlowOptions } from "@vyre/ui";
import { callT as call } from "../../src/real/call-tool";
import { useKernelTypes } from "../customize/kernel-types";
import { SAMPLE_OPTIONS } from "./starters.js";

async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T | null> {
  const r = await call<T>(tool, input);
  return r.error ? null : (r.data as T);
}
const list = (d: any, key: string): any[] => (Array.isArray(d) ? d : Array.isArray(d?.[key]) ? d[key] : []);

export async function realOptions(types: { name: string; label: string }[]): Promise<FlowOptions> {
  const [agents, tpls, roles] = await Promise.all([ask("agents.list"), ask("work.template.list"), ask("roles.list")]);
  const templates = await Promise.all(list(tpls, "templates").filter((t) => !t.archived && t.live !== null).map(async (t) => {
    const g: any = await ask("work.template.get", { template: t.template });
    const stages = list(g?.body, "stages").map((s: any) => ({ name: String(s.name), tasks: list(s, "tasks").map((k: any) => ({ title: String(k.title), doer: String(k.doer) })) }));
    return { id: String(t.template), name: String(t.name), stages };
  }));
  return {
    types,
    agents: list(agents, "agents").map((a) => ({ name: String(a.name), label: String(a.label || a.name) })),
    templates,
    roles: list(roles, "roles").map((r) => ({ name: String(r.name || r.id), label: String(r.label || r.name || r.id) })),
    people: [],
  };
}

/** The options the builder shows, once they are in. */
export function useFlowOptions(): FlowOptions | null {
  const defs = useKernelTypes((s) => s.defs);
  const loadTypes = useKernelTypes((s) => s.load);
  const [opts, setOpts] = useState<FlowOptions | null>(allowsMock() ? SAMPLE_OPTIONS : null);
  useEffect(() => { if (!allowsMock()) loadTypes().catch(() => {}); }, [loadTypes]);
  useEffect(() => {
    if (allowsMock()) return;
    let live = true;
    realOptions(defs.map((d) => ({ name: d.name, label: d.label || d.name }))).then((o) => { if (live) setOpts(o); });
    return () => { live = false; };
  }, [defs]);
  return opts;
}

/** Save a stored Flow on the box. Resolves to the new Flow's id; throws the box's own words when it refuses. */
export async function defineReal(flow: unknown): Promise<string> {
  const r = await call<{ ok: boolean; id?: string; errors?: { path?: string; message: string }[] }>("flows.define", { flow });
  if (r.error) throw new Error(r.error.message);
  const d = r.data;
  if (!d || !d.ok || !d.id) throw new Error((d?.errors || []).map((e) => e.message).join(" ") || "The box would not take that Flow.");
  return d.id;
}
