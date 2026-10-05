// @ts-check
// core/daemon/calendar-sync.js: the Space's calendar, kept in step with an outside calendar, started by default in every Space this home hosts (platform gaps item 6, the lead's ruling of
// 5 Oct 2026). For each Space, every few minutes, for each connector in the vault that is a calendar (its declaration says so: it has events.list, events.insert and events.patch), it runs
// records/calendar/sync.js on the connector declaration: pull outside changes into Event records, push Vyre's own. Nothing here holds a credential: every call is a "Call a service" through the
// kernel's authorize and the vault's forward, as a Flow's step is.
//
// Reads run. A write to the outside calendar is outward (service.call): the kernel decides, and when it says ask, a task is put in front of the owner (the same held act a Flow's step makes),
// the change waits, and it goes out on the next look once the owner has said yes, carrying the approval and the bind of exactly that request. A rule of the Space that refuses (Never, Draft only)
// refuses it. With no calendar connector in the vault this does nothing but look at the catalog.
import fs from "node:fs";
import path from "node:path";
import { createCalendarSync } from "../../records/calendar/sync.js";
import { callThrough } from "../../records/calendar/declared-call.js";
import googleCalendar from "../../records/connectors/google-calendar/declaration.js";
import { requestBind } from "../../kernel/seal/uses.js";

export const EVERY_MS = 5 * 60_000, FIRST_MS = 15_000;
const NEEDS = ["events.list", "events.insert", "events.patch"];

/** @param {{ root: string, log?: (m: string) => void, connectors: () => Promise<Record<string, any>>, everyMs?: number, firstMs?: number }} o */
export function createCalendarSyncHost(o) {
  const log = o.log || (() => {});
  /** @type {Map<string, { stop: () => void, runNow: () => Promise<any> }>} */ const spaces = new Map();
  const dir = path.join(o.root, "calendar-sync");

  /** A small JSON file per Space and connector: the sync token and what was last written each way. */
  function stateFile(/** @type {string} */ space, /** @type {string} */ connector) {
    const file = path.join(dir, `${space}.${connector}.json`.replace(/[^A-Za-z0-9._-]/g, "_"));
    /** @type {Record<string, any>} */ let data = {};
    try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { data = {}; }
    return { get: (/** @type {string} */ k) => data[k], set: (/** @type {string} */ k, /** @type {any} */ v) => { data[k] = v; try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); } catch (e) { log(`calendar sync: could not keep its state: ${/** @type {Error} */ (e).message}`); } } };
  }

  /**
   * @param {{ space: string, gw: any, chains: any, ownerChain: () => any, personChain: (id: string) => any, ownerId: () => string,
   *   service: (q: { chain: any, connector: string, request: any, idem?: string, approval?: string, bind?: string }) => Promise<any> }} s
   */
  function attach(s) {
    if (spaces.has(s.space)) return spaces.get(s.space);
    let busy = false, stopped = false;
    /** @type {Map<string, any>} */ const syncs = new Map();
    const actor = (/** @type {string} */ id) => ({ kind: "person", id, space: s.space });

    /** One connector's sync, made once. */
    function syncFor(/** @type {string} */ connector) {
      let sync = syncs.get(connector);
      if (sync) return sync;
      const state = stateFile(s.space, connector);
      const resource = `vyre://${s.space}/service/${encodeURIComponent(connector)}`;
      const send = async (/** @type {any} */ req, /** @type {any} */ extra) => {
        const approval = extra && extra.approval;
        const r = await s.service({ chain: s.ownerChain(), connector, request: req, idem: extra && extra.idem, ...(approval ? { approval, bind: requestBind({ connector, method: req.method, path: req.path, query: req.query, body: req.body, headers: req.headers }) } : {}) });
        if (r && r.held) throw Object.assign(new Error("the vault is holding the call for a yes"), { code: "held" });
        const text = r && typeof r.body === "string" ? Buffer.from(r.body, "base64").toString("utf8") : "";
        let json; try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
        return { status: Number(r && r.status) || 0, body: json };
      };
      const call = callThrough(googleCalendar, send);
      const pending = () => state.get("pending") || {};
      const setPending = (/** @type {string} */ k, /** @type {any} */ v) => { const p = { ...pending() }; if (v === undefined) delete p[k]; else p[k] = v; state.set("pending", p); };
      /** The approval path for an outward write: allowed, held for the owner's yes, or refused. */
      const write = async (/** @type {any} */ change, /** @type {(extra?: any) => Promise<any>} */ perform) => {
        const chain = s.ownerChain();
        const note = pending()[change.key];
        if (note && note.refused) return { done: false, refused: true };
        const d = await s.gw.authorize({ chain, action: "service.call", resource, ...(note && note.task ? {} : {}) });
        if (d.effect === "deny") { setPending(change.key, { refused: true }); return { done: false, refused: true }; }
        if (d.effect === "allow") return { done: true, value: await perform({ idem: change.key }) };
        // ask: one task per change, then wait for the person
        if (!note || !note.task) {
          const owner = actor(s.ownerId());
          const doerChain = s.chains.forDoer({ flow: "calendar-sync", space: s.space, approver: owner, run: change.key });
          const task = await s.gw.ask.request(chain, { title: `Calendar: ${change.op === "insert" ? "add" : "change"} "${String(change.title).slice(0, 120)}" on the outside calendar?`,
            doer: { kind: "service", id: "flows", space: s.space }, checker: owner, output: { kind: "decision" }, source: "flow_step",
            form: { kind: "held_act", flow: "calendar-sync", run: change.key, step: change.op, action: "service.call", resource, why: "it writes to an outside calendar, which needs a person's yes", input: { op: change.op, title: change.title } } }, { idem: `calendar-sync:${change.key}` });
          for (const [step, arg] of /** @type {any[]} */ ([["start"], ["complete", { answer: "yes", reason: "it writes to an outside calendar" }]])) {
            try { await (step === "start" ? s.gw.ask.start(doerChain, task.id) : s.gw.ask.complete(doerChain, task.id, arg)); } catch (e) { if (!e || !["bad_state", "not_allowed"].includes(/** @type {any} */ (e).code)) throw e; }
          }
          setPending(change.key, { task: task.id });
          return { done: false, held: true };
        }
        const t = await s.gw.ask.get(chain, note.task);
        if (t && t.state === "done" && t.outcome === "approved") {
          const value = await perform({ approval: note.task, idem: change.key });
          setPending(change.key, undefined);
          return { done: true, value };
        }
        if (t && t.outcome === "rejected") { setPending(change.key, { refused: true }); return { done: false, refused: true }; }
        return { done: false, held: true };
      };
      sync = createCalendarSync({ kernel: { records: s.gw.records }, chain: () => s.ownerChain(), call, write, route: connector, calendar: "primary", state,
        report: (type, data) => { if (type === "calendar.conflict") log(`calendar sync ${s.space}: ${type} ${JSON.stringify(data).slice(0, 200)}`); } });
      syncs.set(connector, sync);
      return sync;
    }

    /** One look: every calendar connector in the vault. */
    async function runNow() {
      if (busy || stopped) return null;
      busy = true;
      /** @type {Record<string, any>} */ const out = {};
      try {
        const catalog = await o.connectors().catch(() => ({}));
        for (const [name, c] of Object.entries(catalog || {})) {
          const have = new Set(((c && c.ops) || []).map((/** @type {any} */ x) => x.name));
          if (!NEEDS.every(n => have.has(n))) continue;
          try { out[name] = await syncFor(name).sync(); } catch (e) { out[name] = { error: /** @type {Error} */ (e).message }; log(`calendar sync ${s.space}/${name}: ${/** @type {Error} */ (e).message}`); }
        }
      } finally { busy = false; }
      return out;
    }

    /** @type {NodeJS.Timeout[]} */ const timers = [];
    const first = setTimeout(() => { void runNow(); }, o.firstMs ?? FIRST_MS), every = setInterval(() => { void runNow(); }, o.everyMs ?? EVERY_MS);
    first.unref?.(); every.unref?.(); timers.push(first, every);
    const h = { stop: () => { stopped = true; timers.forEach(t => clearTimeout(t)); }, runNow };
    spaces.set(s.space, h);
    return h;
  }

  return Object.freeze({ attach, get: (/** @type {string} */ space) => spaces.get(space) || null, stop: () => { for (const h of spaces.values()) h.stop(); spaces.clear(); } });
}
