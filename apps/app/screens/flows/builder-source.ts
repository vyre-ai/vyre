// What the Flow builder offers to pick from, and how a finished draft is saved. A sample build answers from SAMPLE_OPTIONS and keeps Flows in memory; the real one asks the vyred
// (records.types through Customize's store, agents.list, work.template.list and get, roles.list) and saves with flows.define, which stores a version nobody has approved yet.
import { useEffect, useState } from "react";
import { allowsMock, type FlowOptions } from "@vyre/ui";
import { callT as call } from "../../src/real/call-tool";
import { useKernelTypes } from "../customize/kernel-types";
import { useSpaces } from "../shell/state";
import { SAMPLE_OPTIONS } from "./starters.js";

async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T | null> {
  const r = await call<T>(tool, input);
  return r.error ? null : (r.data as T);
}
const list = (d: any, key: string): any[] => (Array.isArray(d) ? d : Array.isArray(d?.[key]) ? d[key] : []);

export async function realOptions(types: { name: string; label: string; fields?: { name: string; label: string; kind?: string }[] }[], space?: string | null, reload?: () => void): Promise<FlowOptions> {
  const [vaultNames, agents, tpls, roles, fl, conns, mailCreds, smsCreds, events] = await Promise.all([ask("vault.items.names"), ask("agents.list"), ask("work.template.list"), ask("roles.list"), ask("flows.list"), ask("connectors.connection.list"), ask("comms.credentials", { kind: "email" }), ask("comms.credentials", { kind: "sms" }), ask("events.catalog")]);
  // comms.* is an owner's on a member's door: where it cannot be read the picker says an owner chooses
  const creds = (d: any) => (d && Array.isArray(d.credentials) ? d.credentials.map((c: any) => ({ id: String(c.id), name: String(c.name), provider: String(c.provider), step: String(c.step) })) : null);
  // an agent may approve only if an owner or an admin made it: the agent's page says so (agents.docs.get made_by.staff); where that cannot be read it is not offered
  const staffOf = async (name: string) => { const d: any = await ask("agents.docs.get", { agent: name }); return d?.made_by?.staff === true; };
  const templates = await Promise.all(list(tpls, "templates").filter((t) => !t.archived && t.live !== null).map(async (t) => {
    const g: any = await ask("work.template.get", { template: t.template });
    const stages = list(g?.body, "stages").map((s: any) => ({ name: String(s.name), tasks: list(s, "tasks").map((k: any) => ({ title: String(k.title), doer: String(k.doer) })) }));
    return { id: String(t.template), name: String(t.name), stages };
  }));
  return {
    types,
    agents: await Promise.all(list(agents, "agents").map(async (a) => ({ name: String(a.name), label: String(a.label || a.name), staff: await staffOf(String(a.name)) }))),
    templates,
    vaultItems: (Array.isArray(vaultNames) ? vaultNames : list(vaultNames, "names")).map((n: any) => ({ name: String(typeof n === "string" ? n : n.name), label: String(typeof n === "string" ? n : n.label || n.name) })),
    addConnection: async (c) => {
      const r = await call<any>("connectors.connection.create", { label: c.label, base_url: c.base_url, send: { how: c.how, ...(c.header ? { name: c.header } : {}) }, credential: { item: c.item }, check: { path: c.check || "/" } });
      if (r.error) throw new Error(r.error.message);
      reload?.();
      const id = String(r.data?.id || r.data?.connection?.id || c.label);
      return { name: id, label: c.label };
    },
    connections: list(conns, "connections").map((c) => ({ name: String(c.name), label: String(c.label || c.name) })),
    // every event the running modules announce, for "Something else happens" (the catalog is the owner's to read: a person it refuses sees the plain-worded events only)
    events: list(events, "events").filter((e: any) => e && typeof e.type === "string").map((e: any) => ({ type: String(e.type), ...(typeof e.module === "string" ? { module: e.module } : {}), ...(e.deprecated ? { deprecated: true } : {}) })),
    credentials: creds(mailCreds) && creds(smsCreds) ? { email: creds(mailCreds), sms: creds(smsCreds) } : null,
    flows: list(fl, "flows").filter((f) => f.active).map((f) => ({ name: String(f.name), label: String(f.label || f.name) })),
    roles: list(roles, "roles").map((r) => ({ name: String(r.name || r.id), label: String(r.label || r.name || r.id) })),
    people: [],
    // the tag picker's "a specific record": some records of an object, by the person's own read
    recordsOf: async (type) => {
      const r = await ask<any>("records.query", { type, page: { limit: 20 } });
      return list(r, "rows").map((x: any) => ({ urn: String(x.urn || `vyre://${space ?? "space"}/${type}/${x.id}`), label: String(x.data?.name || x.data?.title || x.data?.label || x.id) }));
    },
  };
}

/** The options the builder shows, once they are in. */
export function useFlowOptions(): FlowOptions | null {
  const defs = useKernelTypes((s) => s.defs);
  const space = useSpaces((s) => s.space);
  const loadTypes = useKernelTypes((s) => s.load);
  const [opts, setOpts] = useState<FlowOptions | null>(allowsMock() ? SAMPLE_OPTIONS : null);
  const [tick, setTick] = useState(0);
  useEffect(() => { if (!allowsMock()) loadTypes().catch(() => {}); }, [loadTypes]);
  useEffect(() => {
    if (allowsMock()) return;
    let live = true;
    const types = defs.map((d) => ({ name: d.name, label: d.label || d.name, fields: (d.fields ?? []).map((f: any) => ({ name: String(f.name), label: String(f.label || f.name), kind: String(f.kind || ""), ...(Array.isArray(f.options) ? { options: f.options.map((o: any) => String(typeof o === "string" ? o : o?.name ?? o?.label ?? o)) } : {}) })) }));
    realOptions(types, space, () => setTick((n) => n + 1)).then((o) => { if (live) setOpts(o); });
    return () => { live = false; };
  }, [defs, space, tick]);
  return opts;
}

/** Save a stored Flow on the box (a new version when `id` is given). Resolves to the new Flow's id; throws the box's own words when it refuses. */
export async function defineReal(flow: unknown, id?: string): Promise<string> {
  const r = await call<{ ok: boolean; id?: string; errors?: { path?: string; message: string }[] }>("flows.define", { flow, ...(id ? { id } : {}) });
  if (r.error) throw new Error(r.error.message);
  const d = r.data;
  if (!d || !d.ok || !d.id) throw new Error((d?.errors || []).map((e) => e.message).join(" ") || "The box would not take that Flow.");
  return d.id;
}
