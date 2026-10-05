// @ts-check
// core/daemon/calendar-sync.js: the Space's calendar, kept in step with an outside calendar, started by default in every Space this home hosts (platform gaps item 6, the lead's ruling of
// 5 Oct 2026). For each Space, every few minutes, for each Google account connected to the google module (the one Google path), it runs records/calendar/sync.js on the Google Calendar
// declaration: pull outside changes into Event records, push Vyre's own. Nothing here holds a credential: every call goes through the google module's google.api, which mints the token.
//
// Reads run. A write to the outside calendar is outward (service.call): the kernel decides, and when it says ask, a task is put in front of the owner (the same held act a Flow's step makes),
// the change waits, and it goes out on the next look once the owner has said yes, carrying the approval and the bind of exactly that request. A rule of the Space that refuses (Never, Draft only)
// refuses it. Whether a write is outward is the declaration's own flag (an op of kind change, send or delete) and nothing else: a change of an event is held for a yes whoever is or is not invited.
// A write that goes out is done safely, from the declaration: it is recorded in a ledger before anything is repeated (Calendar takes no idempotency header), it is read back and compared, and it stays
// under the connector's declared rate. With no Google account connected this does nothing.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createCalendarSync } from "../../records/calendar/sync.js";
import { callThrough } from "../../records/calendar/declared-call.js";
import googleCalendar from "../../records/connectors/google-calendar/declaration.js";
import { requestBind } from "../../kernel/seal/uses.js";
import { buildRequest, isOutward, readbackRequest, compareReadback } from "../../records/connectors/format.js";

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
      /** Is the connector's declared per-minute rate used up right now? (checked BEFORE an approval is spent, so a yes is never used up by a write that then has to wait) */
      const rateFull = () => { const per = Number(/** @type {any} */ (googleCalendar).rate && /** @type {any} */ (googleCalendar).rate.per_minute) || 0; return per > 0 && (state.get("sent_at") || []).filter((/** @type {number} */ t) => Date.now() - t < 60_000).length >= per; };
      /**
       * A write that goes out, done safely from the declaration (the Flow runner's safe-write rules, kernel/flows/safe-write.js, as far as a Calendar write needs them): a ledger remembers what this
       * exact change already sent, so a repeat sends nothing; the declared rate is kept; and the write is read back and compared with what was sent.
       * @param {any} change @param {any} req @param {(extra?: any) => Promise<any>} perform @param {any} extra
       */
      const safely = async (change, req, perform, extra) => {
        const ledger = state.get("ledger") || {};
        if (ledger[change.key]) return { done: true, value: ledger[change.key] };
        const per = Number(/** @type {any} */ (googleCalendar).rate && /** @type {any} */ (googleCalendar).rate.per_minute) || 0;
        const nowMs = Date.now();
        const window = (state.get("sent_at") || []).filter((/** @type {number} */ t) => nowMs - t < 60_000);
        if (per && window.length >= per) return { done: false, held: true, waiting: "rate" };
        const res = await perform(extra);
        state.set("sent_at", [...window, nowMs]);
        if (res && res.status === 429) return { done: false, held: true, waiting: "rate" };
        if (res && res.status >= 200 && res.status < 300) {
          const rb = readbackRequest(googleCalendar, change.opName, { request: { params: change.input && change.input.params, query: change.input && change.input.query, body: req.body }, response: { json: res.body } });
          if (rb) {
            const read = await send(rb.request);
            const cmp = compareReadback(googleCalendar, change.opName, { request: { params: change.input && change.input.params, query: change.input && change.input.query, body: req.body }, response: { json: res.body } }, { json: read.body });
            if (!cmp.ok) { log(`calendar sync ${s.space}: the outside calendar does not match what was written (${cmp.mismatches.map(m => m.field).join(", ")}); stopped`); setPending(change.key, { refused: true, mismatch: cmp.mismatches.map(m => m.field) }); return { done: false, refused: true }; }
          }
          const kept = Object.entries({ ...ledger, [change.key]: { status: res.status, body: res.body } }).slice(-200);
          state.set("ledger", Object.fromEntries(kept));
        }
        return { done: true, value: res };
      };
      /** The approval path for an outward write: allowed, held for the owner's yes, or refused. */
      const write = async (/** @type {any} */ change, /** @type {(extra?: any) => Promise<any>} */ perform) => {
        const chain = s.ownerChain();
        const note = pending()[change.key];
        if (note && note.refused) return { done: false, refused: true };
        // The request exactly as it would be sent, and its bind: what the card shows and what the approval is tied to.
        const req = buildRequest(googleCalendar, change.opName, change.input);
        const bind = requestBind({ connector, method: req.method, path: req.path, query: req.query, body: req.body, headers: req.headers });
        // The declaration alone says whether this write is outward (the op's kind); nothing here decides it from who is invited.
        const op = /** @type {any} */ (googleCalendar.ops)[change.opName];
        if (!op) { setPending(change.key, { refused: true }); return { done: false, refused: true }; }
        const outward = isOutward(op);
        const d = await s.gw.authorize({ chain, action: outward ? "service.call" : "service.read", resource });
        if (d.effect === "deny") { setPending(change.key, { refused: true }); return { done: false, refused: true }; }
        if (d.effect === "allow") return safely(change, req, perform, { idem: change.key });
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
          // An approval is single use. Once it has been spent for exactly this request (the write then had to wait, a 429 or the rate window), the yes is kept in the note and the same request is sent on the next
          // look without asking the kernel again; a window that is full is noticed BEFORE the approval is spent.
          if (note.spent && note.bind === bind) {
            const r = await safely(change, req, perform, { approval: note.task, idem: change.key });
            if (r.done) setPending(change.key, undefined);
            return r;
          }
          if (rateFull()) return { done: false, held: true, waiting: "rate" };
          // Google is not called through the vault's forward, so the approval is checked here, for this act and no other.
          // The approval is the task's DOER's to spend (the Flows service under the owner): it is presented as that doer, and needs no standing grant of its own.
          const doerChain = s.chains.forDoer({ flow: "calendar-sync", space: s.space, approver: actor(s.ownerId()), run: change.key });
          const ok = await s.gw.authorize({ chain: doerChain, action: "service.call", resource, approval: note.task, bind });
          if (ok.effect !== "allow") { setPending(change.key, { refused: true }); return { done: false, refused: true }; }
          setPending(change.key, { task: note.task, bind, spent: true });
          const r = await safely(change, req, perform, { approval: note.task, idem: change.key });
          if (r.done) setPending(change.key, undefined);
          return r;
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
