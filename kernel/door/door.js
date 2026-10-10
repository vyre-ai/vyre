// kernel/door/door.js: the inference door (K3). Every call to any model, from any provider, goes through `call`: declared sinks only, bounds,
// residency, budget, then every message is scanned (the sealing process swaps sealed-looking values for placeholders and keeps the originals),
// the session's seal ledger refuses any prompt that still holds a value the session resolved or revealed, the driver is called, and what comes
// back is scanned and ledgered too (a service that echoes a value must not hand it to a model). Contract 8.4; invariants 5 and 6.
// A refusal says which rule fired and the class, never the value. Events carry counts and classes only.
import crypto from "node:crypto";
import { Ledger } from "../seal/ledger.js";
import { createStreamScanner } from "./stream.js";

const MAX_MESSAGES = 2000, MAX_CHARS = 2_000_000, MAX_TOOL_INPUT = 256 * 1024, MAX_TOOLS = 64;
const IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]{1,8000000}$/;
const textOf = c => (Array.isArray(c) ? c.map(p => (p && p.type === "text" ? String(p.text) : "")).join("") : String(c));
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
export function createDoor({ sealer, drivers, sinks, residency = () => null, budget = { reserve: () => null }, emit = () => {}, isChain: kernelIsChain }) {
  const sinkSet = new Set(sinks), ledgers = new Map();
  const refuse = (r, input, extra = {}) => { emit("model.refused", { code: r.code, class: r.class, purpose: input.purpose, session: input.session, ...extra }); throw new DoorRefusal(r); };

  /** The session's ledger, created on first use. A derived session (a sub-agent, a forked chat) starts from its parent's. */
  function ledger(space, session, parent) {
    const k = `${space}\0${session}`, pk = `${space}\0${parent}`;
    if (!ledgers.has(k)) ledgers.set(k, parent && ledgers.has(pk) ? ledgers.get(pk).derive() : new Ledger());
    return ledgers.get(k);
  }
  // At wiring the kernel passes its own `isChain`: the `not_a_sink` test reads the last hop of a chain only the kernel could have built (K3 R-4).
  const isChain = kernelIsChain || (c => c && typeof c.space === "string" && Array.isArray(c.hops) && c.hops.length > 0 && c.hops.every(h => h?.actor?.kind && h.actor.id));
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

  /** A tool call's input goes to an executor as written, so it is not sanitised but judged: any sealed-looking shape or ledgered value in it is a hit. @returns {Promise<null | { code: string, class: string }>} */
  async function scanTool(chain, session, toolInput, input) {
    const text = JSON.stringify(toolInput ?? null), l = ledger(chain.space, session, input.parent_session);
    const r = await sealer.detect({ chain, session, text, ledger_key: keyOf(l) }); l.add(r.ledger);
    if (r.found.length) return { code: "sealed_shape", class: r.found[0].class };
    const hit = l.check(text);
    return hit?.too_big ? { code: "budget", class: "scan" } : hit?.hit ? { code: "ledger_hit", class: hit.hit } : null;
  }
  /** A call that never reached the provider spends nothing. */
  const giveBack = input => { if (budget.release) budget.release(input); else budget.settle?.(input, { cost_micro: 0 }); };
  /** The checks every model call passes before anything is sent: a real chain, a declared sink, bounds, residency, budget, and every message scanned. */
  async function admit(input) {
    const { chain } = input;
    if (!isChain(chain)) throw new TypeError("not a kernel chain");
    const last = chain.hops[chain.hops.length - 1];
    if (last.actor.kind === "service" && !sinkSet.has(last.actor.id)) refuse({ code: "not_a_sink", detail: "service is not a declared model sink" }, input);
    if (!Array.isArray(input.messages) || input.messages.length === 0 || input.messages.length > MAX_MESSAGES
      || input.messages.reduce((n, m) => n + textOf(m.content).length, 0) > MAX_CHARS) refuse({ code: "budget", meter: "prompt_size" }, input);
    const driver = drivers[input.provider];
    const res = !driver ? "provider is not available" : residency({ provider: input.provider, model: input.model, chain });
    if (res) refuse({ code: "residency", detail: res }, input);
    const over = budget.reserve(input); if (over) refuse({ code: "budget", meter: over }, input);
    const session = input.session ?? `call_${crypto.randomUUID()}`, messages = [];
    // A message is words, or a list of parts: words are scanned, a picture (a data URL of a PNG, JPEG, GIF or WebP) goes as it is, anything else is refused.
    const part = async (p, ctx) => (p && p.type === "text" ? { type: "text", text: await scan(chain, session, String(p.text), ctx) } : p && p.type === "image_url" && p.image_url && IMAGE.test(String(p.image_url.url)) ? { type: "image_url", image_url: { url: p.image_url.url } } : refuse({ code: "budget", meter: "prompt_part" }, input));
    try { for (const m of input.messages) messages.push({ role: m.role, content: Array.isArray(m.content) ? await m.content.reduce(async (acc, p) => { const out = await acc; out.push(await part(p, { ...input, session })); return out; }, Promise.resolve([])) : await scan(chain, session, String(m.content), { ...input, session }) }); } catch (e) { giveBack(input); throw e; }
    return { chain, session, messages, driver };
  }

  return {
    /** True when the door was built with the kernel's own `isChain`: the gateway refuses a door that was not (K3 R-4). */
    usesKernelChain: Boolean(kernelIsChain),
    /** The session's ledger key for the sealing process's reveal and detect calls; entries it returns are added with `note`. A session is (Space, id). */
    ledgerKey: (chain, session, parent) => keyOf(ledger(chain.space, session, parent)),
    note: (chain, session, entries) => { ledger(chain.space, session).add(entries); },
    /** Sanitised text for a transcript, a memory or a cache: the only form that may be persisted. A ledger hit is refused. */
    async sanitize({ chain, session, text, purpose = "other" }) { return scan(chain, session, text, { purpose, session }); },
    /** The tool or effect result a model is about to see (D-2): scanned for sealed shapes and ledgered values. */
    async result({ chain, session, text, purpose = "other" }) { return scan(chain, session, text, { purpose, session }); },
    /** The model names a provider's own list gives for one account, from the driver that holds the key and the address: names only, never the key or the body. A service must be a declared sink, as for a call. */
    async listModels({ chain, provider, account }) {
      if (!isChain(chain)) throw new TypeError("not a kernel chain");
      const d = drivers[provider], last = chain.hops[chain.hops.length - 1];
      if ((last.actor.kind === "service" && !sinkSet.has(last.actor.id)) || !d || typeof d.models !== "function") refuse({ code: "not_a_sink", detail: "not a declared model sink, or this provider has no model list to ask for" }, { purpose: "models" });
      return (await d.models({ account })).slice(0, 500).map(n => String(n).slice(0, 120));
    },
    async endSession(chain, session) { ledgers.delete(`${chain.space}\0${session}`); await sealer.endSession(chain, session); },

    /**
     * The streaming call. The request is checked exactly as `call` checks it (a refusal is thrown on the first `next`). The reply is scanned as it arrives
     * (stream.js): text is released only once no value could still be forming in it, and on any hit the upstream is stopped and the stream ends with
     * `{ type: "cut", code, class }` and a `model.cut` event, so the turn can be marked. A tool call is delivered only after its whole input is scanned.
     * The driver's `stream(input)` yields `{ text }`, `{ tool: { id, name, input } }` or `{ tool_start }`, `{ tool_delta: { id, json } }`, `{ tool_end: { id } }`, and `{ done: { usage } }`.
     * @param {import("../contracts/model.d.ts").ModelCallInput & { parent_session?: string }} input
     * @returns {AsyncGenerator<{ type: "text", text: string } | { type: "tool_call", id: string, name: string, input: unknown } | { type: "cut", code: string, class?: string } | { type: "done", id: string, usage?: any }>}
     */
    async *stream(input) {
      const { chain, session, messages, driver } = await admit(input);
      if (typeof driver.stream !== "function") { giveBack(input); refuse({ code: "residency", detail: "provider does not stream" }, input); }
      const l = ledger(chain.space, session, input.parent_session), sc = createStreamScanner({ ledger: l, detect: text => sealer.detect({ chain, session, text, ledger_key: keyOf(l) }) });
      const it = driver.stream({ ...input, chain: undefined, messages })[Symbol.asyncIterator](), tools = new Map();
      let usage, id = crypto.randomUUID(), cut = null;
      const stop = async () => { try { await it.return?.(); } catch { /* the upstream is gone either way */ } };
      let answered = false;
      try {
        for (;;) {
          const { value: ev, done } = await it.next(); if (done) break; answered = true;
          if (typeof ev.text === "string") { const r = await sc.push(ev.text); if (r.cut) { cut = r.cut; break; } if (r.text) yield { type: "text", text: r.text }; }
          else if (ev.tool_start) { if (tools.size >= MAX_TOOLS) { cut = { code: "budget", class: "tool_input" }; break; } tools.set(ev.tool_start.id, { name: ev.tool_start.name, json: "" }); }
          else if (ev.tool_delta) { const t = tools.get(ev.tool_delta.id); if (t) { t.json += String(ev.tool_delta.json); if (t.json.length > MAX_TOOL_INPUT) { cut = { code: "budget", class: "tool_input" }; break; } } }
          else if (ev.tool || ev.tool_end) {
            const t = ev.tool ?? (() => { const x = tools.get(ev.tool_end.id); tools.delete(ev.tool_end.id); let inp = null; try { inp = x.json ? JSON.parse(x.json) : {}; } catch { inp = x.json; } return { id: ev.tool_end.id, name: x.name, input: inp }; })();
            const bad = await scanTool(chain, session, t.input, input); if (bad) { cut = bad; break; }
            yield { type: "tool_call", id: t.id, name: t.name, input: t.input };
          } else if (ev.done) { usage = ev.done.usage; id = ev.done.id ?? id; }
        }
        if (!cut) { const r = await sc.end(); if (r.cut) cut = r.cut; else if (r.text) yield { type: "text", text: r.text }; }
      } catch (e) {
        // The same rule as `call`: nothing came back, nothing is spent; something did, and what it cost is settled.
        if (answered) budget.settle?.(input, usage); else giveBack(input);
        throw e;
      } finally { if (cut) await stop(); }
      if (cut) { emit("model.cut", { code: cut.code, class: cut.class, purpose: input.purpose, session }); budget.settle?.(input, usage); if (!input.session) await this.endSession(chain, session); yield { type: "cut", ...cut }; return; }
      budget.settle?.(input, usage); if (!input.session) await this.endSession(chain, session);
      yield { type: "done", id, usage };
    },

    /** @param {import("../contracts/model.d.ts").ModelCallInput & { parent_session?: string }} input */
    async call(input) {
      const { chain, session, messages, driver } = await admit(input);
      // Everything after the reservation gives it back when it fails: a refused or failed call spends nothing.
      let out, content;
      try {
        out = await driver.call({ ...input, chain: undefined, messages });
        content = await scan(chain, session, String(out.content ?? ""), { ...input, session });
        for (const t of out.tool_calls ?? []) { const bad = await scanTool(chain, session, t.input, input); if (bad) refuse(bad, input); }
      } catch (e) {
        // A call the provider never answered spends nothing; one it answered before a scan refused it cost what it cost (the usage it reported).
        if (out) budget.settle?.(input, out.usage); else giveBack(input);
        throw e;
      }
      budget.settle?.(input, out.usage);
      if (!input.session) await this.endSession(chain, session);
      return { ...out, id: out.id ?? crypto.randomUUID(), content };
    },
  };
}
