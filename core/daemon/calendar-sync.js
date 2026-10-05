// @ts-check
// core/daemon/calendar-sync.js: the Space's calendar, kept in step with an outside calendar, started by default in every Space this home hosts (platform gaps item 6, the lead's ruling of
// 5 Oct 2026). For each Space, every few minutes, for each Google account connected to the google module (the one Google path), it runs records/calendar/sync.js on the Google Calendar
// declaration: pull outside changes into Event records, push Vyre's own. Nothing here holds a credential: every call goes through the google module's google.api, which mints the token.
//
// Reads run. A write to the outside calendar is outward (service.call): the kernel decides, and when it says ask, a task is put in front of the owner (the same held act a Flow's step makes),
// the change waits, and it goes out on the next look once the owner has said yes, carrying the approval and the bind of exactly that request. A rule of the Space that refuses (Never, Draft only)
// refuses it. An event on the person's own calendar with nobody invited reaches no one else and is written without asking. With no Google account connected this does nothing.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createCalendarSync } from "../../records/calendar/sync.js";
import { callThrough } from "../../records/calendar/declared-call.js";
import googleCalendar from "../../records/connectors/google-calendar/declaration.js";
import { requestBind } from "../../kernel/seal/uses.js";
import { buildRequest } from "../../records/connectors/format.js";

export const EVERY_MS = 5 * 60_000, FIRST_MS = 15_000;

/** @param {{ root: string, log?: (m: string) => void, everyMs?: number, firstMs?: number }} o */
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
   *   subscribe?: (cb: (e: any) => any) => any,
   *   google?: { accounts: () => Promise<{ name: string }[]>, api: (account: string, req: any) => Promise<{ status: number, body: any }> } }} s
   */
  function attach(s) {
    if (spaces.has(s.space)) return spaces.get(s.space);
    let busy = false, stopped = false;
    /** @type {Map<string, any>} */ const syncs = new Map();
    /** @type {Map<string, any>} */ const states = new Map();
    const actor = (/** @type {string} */ id) => ({ kind: "person", id, space: s.space });

    /** One connector's sync, made once. */
    function syncFor(/** @type {string} */ connector, /** @type {string} */ googleAccount) {
      let sync = syncs.get(connector);
      if (sync) return sync;
      const state = stateFile(s.space, connector);
      const resource = `vyre://${s.space}/service/${encodeURIComponent(connector)}`;
      // A connected Google account (the google module owns its token) is called through google.api.
      const send = async (/** @type {any} */ req) => {
        const r = await /** @type {any} */ (s.google).api(googleAccount, { method: req.method, path: req.path, ...(req.query ? { query: req.query } : {}), ...(req.body !== undefined ? { body: req.body } : {}), ...(req.headers ? { headers: req.headers } : {}) });
        return { status: Number(r && r.status) || 0, body: (r && r.body) || {} };
      };
      const call = callThrough(googleCalendar, send);
      const pending = () => state.get("pending") || {};
      const setPending = (/** @type {string} */ k, /** @type {any} */ v) => { const p = { ...pending() }; if (v === undefined) delete p[k]; else p[k] = v; state.set("pending", p); };
      /** The approval path for an outward write: allowed, held for the owner's yes, or refused. */
      const write = async (/** @type {any} */ change, /** @type {(extra?: any) => Promise<any>} */ perform) => {
        const chain = s.ownerChain();
        const note = pending()[change.key];
        if (note && note.refused) return { done: false, refused: true };
        // The request exactly as it would be sent, and its bind: what the card shows and what the approval is tied to.
        const req = buildRequest(googleCalendar, change.opName, change.input);
        const bind = requestBind({ connector, method: req.method, path: req.path, query: req.query, body: req.body, headers: req.headers });
        const d = await s.gw.authorize({ chain, action: "service.call", resource });
        if (d.effect === "deny") { setPending(change.key, { refused: true }); return { done: false, refused: true }; }
        if (d.effect === "allow") return { done: true, value: await perform({ idem: change.key }) };
        // An event only on the person's own calendar (nobody invited) reaches no one else, so it is not outward and is written without asking (with sendUpdates left at none); one that invites people is.
        const invites = Array.isArray(change.detail && change.detail.people) && change.detail.people.length > 0;
        if (!invites) return { done: true, value: await perform({ idem: change.key }) };
        // ask: one task per change, then wait for the person. A change whose request is no longer the one asked about (the event was edited) is asked again.
        if (!note || !note.task || note.bind !== bind) {
          const owner = actor(s.ownerId());
          const doerChain = s.chains.forDoer({ flow: "calendar-sync", space: s.space, approver: owner, run: change.key });
          const det = change.detail || {};
          const sha = crypto.createHash("sha256").update(JSON.stringify(req.body)).digest("hex").slice(0, 16);
          const when = `${det.starts_at || "?"}${det.ends_at ? ` to ${det.ends_at}` : ""}`;
          const task = await s.gw.ask.request(chain, { title: `Calendar: ${change.op === "insert" ? "add" : "change"} "${String(change.title).slice(0, 100)}" (${when}${det.people && det.people.length ? `, with ${det.people.slice(0, 5).join(", ")}${det.people.length > 5 ? ` and ${det.people.length - 5} more` : ""}` : ""}) on the outside calendar?`.slice(0, 200),
            doer: { kind: "service", id: "flows", space: s.space }, checker: owner, output: { kind: "decision" }, source: "flow_step",
            form: { kind: "held_act", flow: "calendar-sync", run: change.key, step: change.op, action: "service.call", resource, why: "it writes to an outside calendar, which needs a person's yes", bind, digest: sha,
              input: { op: change.op, ...det, invites: Array.isArray(det.people) && det.people.length > 0 } } }, { idem: `calendar-sync:${change.key}:${bind.slice(0, 12)}` });
          for (const [step, arg] of /** @type {any[]} */ ([["start"], ["complete", { answer: "yes", reason: "it writes to an outside calendar" }]])) {
            try { await (step === "start" ? s.gw.ask.start(doerChain, task.id) : s.gw.ask.complete(doerChain, task.id, arg)); } catch (e) { if (!e || !["bad_state", "not_allowed"].includes(/** @type {any} */ (e).code)) throw e; }
          }
          setPending(change.key, { task: task.id, bind });
          return { done: false, held: true };
        }
        const t = await s.gw.ask.get(chain, note.task);
        if (t && t.state === "done" && t.outcome === "approved") {
          // Google is not called through the vault's forward, so the approval is checked here, for this act and no other.
          const ok = await s.gw.authorize({ chain, action: "service.call", resource, approval: note.task });
          if (ok.effect !== "allow") { setPending(change.key, { refused: true }); return { done: false, refused: true }; }
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
      states.set(connector, state);
      return sync;
    }

    /** One look: every Google account connected to the google module (a real calendar the person signed in), by the same sync. */
    async function runNow() {
      if (busy || stopped) return null;
      busy = true;
      /** @type {Record<string, any>} */ const out = {};
      try {
        const accts = s.google ? await s.google.accounts().catch(() => []) : [];
        for (const a of accts) {
          const key = `google-${a.name}`;
          try { out[key] = await syncFor(key, a.name).sync(); } catch (e) { out[key] = { error: /** @type {Error} */ (e).message }; log(`calendar sync ${s.space}/${key}: ${/** @type {Error} */ (e).message}`); }
        }
      } finally { busy = false; }
      return out;
    }

    // The owner's yes (or no) on a change this sync is holding is acted on at once, not at the next look: the event of the decided task starts a look.
    const mine = (/** @type {string} */ id) => [...states.values()].some(st => Object.values(st.get("pending") || {}).some((/** @type {any} */ n) => n && n.task === id));
    /** @type {any} */ let unsubscribe = null;
    if (s.subscribe) unsubscribe = s.subscribe((/** @type {any} */ e) => {
      if (!e || (e.type !== "task.approved" && e.type !== "task.rejected")) return;
      const id = String(e.subject || "").split("/").pop() || "";
      if (mine(id)) void runNow();
    });
    /** @type {NodeJS.Timeout[]} */ const timers = [];
    const first = setTimeout(() => { void runNow(); }, o.firstMs ?? FIRST_MS), every = setInterval(() => { void runNow(); }, o.everyMs ?? EVERY_MS);
    first.unref?.(); every.unref?.(); timers.push(first, every);
    const h = { stop: () => { stopped = true; timers.forEach(t => clearTimeout(t)); if (typeof unsubscribe === "function") unsubscribe(); }, runNow };
    spaces.set(s.space, h);
    return h;
  }

  return Object.freeze({ attach, get: (/** @type {string} */ space) => spaces.get(space) || null, stop: () => { for (const h of spaces.values()) h.stop(); spaces.clear(); } });
}
