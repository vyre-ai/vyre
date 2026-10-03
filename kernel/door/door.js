// kernel/door/door.js: the inference door (K3). Every call to any model, from any provider, goes through `call`: declared sinks only, bounds,
// residency, budget, then every message is scanned (the sealing process swaps sealed-looking values for placeholders and keeps the originals),
// the session's seal ledger refuses any prompt that still holds a value the session resolved or revealed, the driver is called, and what comes
// back is scanned and ledgered too (a service that echoes a value must not hand it to a model). Contract 8.4; invariants 5 and 6.
// A refusal says which rule fired and the class, never the value. Events carry counts and classes only.
import crypto from "node:crypto";
import { Ledger } from "../seal/ledger.js";

const MAX_MESSAGES = 2000, MAX_CHARS = 2_000_000;
export class DoorRefusal extends Error {
  /** @param {{ code: string, [k: string]: any }} refusal */
  constructor(refusal) { super(refusal.code); this.code = refusal.code; this.refusal = refusal; }
}

/**
 * @param {{ sealer: { detect(i: any): Promise<any>, endSession(s: string): Promise<any> },
 *           drivers: Record<string, { call(i: any): Promise<any> }>, sinks: Iterable<string>,
 *           residency?: (i: { provider: string, model: string, chain: any }) => string | null,
 *           budget?: { reserve(i: any): string | null, settle?(i: any, usage: any): void },
 *           emit?: (type: string, payload: any) => void }} o
 */
export function createDoor({ sealer, drivers, sinks, residency = () => null, budget = { reserve: () => null }, emit = () => {} }) {
  const sinkSet = new Set(sinks), ledgers = new Map();
  const refuse = (r, input, extra = {}) => { emit("model.refused", { code: r.code, class: r.class, purpose: input.purpose, session: input.session, ...extra }); throw new DoorRefusal(r); };

  /** The session's ledger, created on first use. A derived session (a sub-agent, a forked chat) starts from its parent's. */
  function ledger(space, session, parent) {
    const k = `${space}\0${session}`, pk = `${space}\0${parent}`;
    if (!ledgers.has(k)) ledgers.set(k, parent && ledgers.has(pk) ? ledgers.get(pk).derive() : new Ledger());
    return ledgers.get(k);
  }
  const isChain = c => c && typeof c.space === "string" && Array.isArray(c.hops) && c.hops.length > 0 && c.hops.every(h => h?.actor?.kind && h.actor.id);
  const keyOf = l => l.key.toString("base64");

  /** Scan one text: placeholders in place of sealed-looking values, ledger entries recorded, then the ledger check. */
  async function scan(chain, session, text, input) {
    if (!isChain(chain)) throw new TypeError("not a kernel chain");
    const l = ledger(chain.space, session, input.parent_session);
    const r = await sealer.detect({ chain, session, text, ledger_key: keyOf(l) });
    l.add(r.ledger);
    if (r.found.length) emit("model.sanitized", { session, purpose: input.purpose, found: r.found.map(f => ({ class: f.class, n: f.n })) });
    const hit = l.check(r.text);
    if (hit?.too_big) refuse({ code: "budget", meter: "scan" }, input);
    if (hit?.hit) refuse({ code: "ledger_hit", class: hit.hit }, input);
    return r.text;
  }

  return {
    /** The session's ledger key for the sealing process's reveal and detect calls; entries it returns are added with `note`. A session is (Space, id). */
    ledgerKey: (chain, session, parent) => keyOf(ledger(chain.space, session, parent)),
    note: (chain, session, entries) => { ledger(chain.space, session).add(entries); },
    /** Sanitised text for a transcript, a memory or a cache: the only form that may be persisted. A ledger hit is refused. */
    async sanitize({ chain, session, text, purpose = "other" }) { return scan(chain, session, text, { purpose, session }); },
    /** The tool or effect result a model is about to see (D-2): scanned for sealed shapes and ledgered values. */
    async result({ chain, session, text, purpose = "other" }) { return scan(chain, session, text, { purpose, session }); },
    async endSession(chain, session) { ledgers.delete(`${chain.space}\0${session}`); await sealer.endSession(chain, session); },

    /** @param {import("../contracts/model.d.ts").ModelCallInput & { parent_session?: string }} input */
    async call(input) {
      const { chain } = input;
      if (!isChain(chain)) throw new TypeError("not a kernel chain");
      const last = chain.hops[chain.hops.length - 1];
      if (last.actor.kind === "service" && !sinkSet.has(last.actor.id)) refuse({ code: "not_a_sink", detail: "service is not a declared model sink" }, input);
      if (!Array.isArray(input.messages) || input.messages.length === 0 || input.messages.length > MAX_MESSAGES
        || input.messages.reduce((n, m) => n + String(m.content).length, 0) > MAX_CHARS) refuse({ code: "budget", meter: "prompt_size" }, input);
      const driver = drivers[input.provider];
      const res = !driver ? "provider is not available" : residency({ provider: input.provider, model: input.model, chain });
      if (res) refuse({ code: "residency", detail: res }, input);
      const over = budget.reserve(input); if (over) refuse({ code: "budget", meter: over }, input);

      const session = input.session ?? `call_${crypto.randomUUID()}`;
      const messages = [];
      for (const m of input.messages) messages.push({ role: m.role, content: await scan(chain, session, String(m.content), { ...input, session }) });
      const out = await driver.call({ ...input, chain: undefined, messages });
      const content = await scan(chain, session, String(out.content ?? ""), { ...input, session });
      for (const t of out.tool_calls ?? []) await scan(chain, session, JSON.stringify(t.input ?? null), { ...input, session });
      budget.settle?.(input, out.usage);
      if (!input.session) await this.endSession(chain, session);
      return { ...out, id: out.id ?? crypto.randomUUID(), content };
    },
  };
}
