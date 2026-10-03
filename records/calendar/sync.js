// @ts-check
// Two-way sync between a Space's Event records and an outside calendar (Google first), through the vault's route. Nothing here holds a
// credential or opens a connection: every call goes through `request`, the vault route (vault.request: the credential and its allowed
// hosts live in the vault, the sync only names the credential). Events are written through the kernel's records door like any other
// record, so grants, the log and sealing apply.
//
//   pull   outside -> Vyre. Incremental by Google's sync token; a changed event updates its record, a new one makes a record, a
//          cancelled one removes it. Runs on a schedule trigger (sessions): nothing here polls.
//   push   Vyre -> outside. A record that came from Vyre (or was edited here) is inserted or patched. This is an OUTWARD act and
//          follows the Space's approval rule through `policy`: "allow", "hold" (an ask-first task decides, `hold` returns when decided)
//          or "refuse" (a Never rule, or Draft only). With no policy nothing is written outward.
//   edits  both sides changed: the outside copy is fetched again (If-Match on the etag) and wins, and a `calendar.conflict` is reported.

import { fromGoogle, toGoogle } from "./google.js";

const API = "https://www.googleapis.com/calendar/v3";

/**
 * @param {{
 *   kernel: { records: any }, chain: () => any, request: (r: { method: string, url: string, body?: any, headers?: Record<string, string> }) => Promise<{ status: number, body: any }>,
 *   calendar?: string, route?: string,
 *   policy?: (change: { op: "insert" | "patch" | "delete", record: string, title: string }) => Promise<"allow" | "hold" | "refuse"> | "allow" | "hold" | "refuse",
 *   hold?: (change: { op: string, record: string, title: string }) => Promise<boolean>,
 *   state?: { get: (k: string) => any, set: (k: string, v: any) => void },
 *   report?: (type: string, data: any) => void,
 * }} o
 */
export function createCalendarSync(o) {
  const cal = encodeURIComponent(o.calendar ?? "primary"), route = o.route ?? "google-calendar";
  const R = o.kernel.records, report = o.report ?? (() => {});
  const mem = new Map();
  const state = o.state ?? { get: (/** @type {string} */ k) => mem.get(k), set: (/** @type {string} */ k, /** @type {any} */ v) => { mem.set(k, v); } };
  /** @type {Promise<any>} one sync at a time: a pull and a push must not interleave on the same events */ let busy = Promise.resolve();
  const serial = (/** @type {() => Promise<any>} */ fn) => { const p = busy.then(fn, fn); busy = p.catch(() => {}); return p; };
  /** per record: the version we last wrote or read and the etag it matched, so our own writes are not echoed */
  const synced = () => state.get("synced") || {};
  const mark = (/** @type {string} */ id, /** @type {any} */ v) => state.set("synced", { ...synced(), [id]: v });

  async function byExternal(/** @type {string} */ id) {
    const page = await R.query(o.chain(), "event", { filter: { and: [{ field: "calendar", op: "eq", value: route }, { field: "external_id", op: "eq", value: id }] }, page: { limit: 1 } });
    return page.rows[0] ?? null;
  }

  /** Outside -> Vyre. @returns {Promise<{ created: number, updated: number, removed: number }>} */
  function pull() {
    return serial(async () => {
      const out = { created: 0, updated: 0, removed: 0 };
      let token = state.get("syncToken"), pageToken;
      for (;;) {
        const q = new URLSearchParams({ singleEvents: "true", showDeleted: "true", maxResults: "250", ...(token ? { syncToken: token } : {}), ...(pageToken ? { pageToken } : {}) });
        const res = await o.request({ method: "GET", url: `${API}/calendars/${cal}/events?${q}` });
        if (res.status === 410) { state.set("syncToken", undefined); token = undefined; pageToken = undefined; continue; } // the token expired: start over
        if (res.status !== 200) throw Object.assign(new Error(`the calendar answered ${res.status}`), { code: "unavailable" });
        for (const g of res.body.items || []) {
          const existing = await byExternal(g.id);
          if (g.status === "cancelled") { if (existing) { await R.remove(o.chain(), "event", existing.id, existing.version); out.removed++; } continue; }
          const data = fromGoogle(g, route);
          if (!data) continue;
          if (existing) {
            const mine = synced()[existing.id];
            if (mine && mine.etag === g.etag) continue; // our own write coming back: nothing changed outside
            // edited here since we last synced: this side is newer, the push below sends it; do not overwrite it with the old outside copy
            if (mine && !mine.conflict && existing.version > mine.version) continue;
            const patch = Object.fromEntries(Object.entries(data).filter(([k, v]) => k !== "source" && JSON.stringify(existing.data[k]) !== JSON.stringify(v)));
            if (Object.keys(patch).length) { const r = await R.update(o.chain(), "event", existing.id, patch, existing.version); mark(r.id, { version: r.version, etag: g.etag }); out.updated++; }
            else mark(existing.id, { version: existing.version, etag: g.etag });
          } else { const r = await R.create(o.chain(), "event", data); mark(r.id, { version: r.version, etag: g.etag }); out.created++; }
        }
        if (res.body.nextPageToken) { pageToken = res.body.nextPageToken; continue; }
        if (res.body.nextSyncToken) state.set("syncToken", res.body.nextSyncToken);
        return out;
      }
    });
  }

  async function allowed(/** @type {{ op: "insert" | "patch" | "delete", record: string, title: string }} */ change) {
    const verdict = o.policy ? await o.policy(change) : "refuse";
    if (verdict === "allow") return true;
    if (verdict === "hold") return Boolean(o.hold && (await o.hold(change)));
    return false;
  }

  /** Vyre -> outside. @returns {Promise<{ inserted: number, patched: number, held: number, refused: number, conflicts: number }>} */
  function push() {
    return serial(async () => {
      const out = { inserted: 0, patched: 0, held: 0, refused: 0, conflicts: 0 };
      const page = await R.query(o.chain(), "event", { filter: { field: "calendar", op: "eq", value: route }, page: { limit: 200 } });
      const fresh = await R.query(o.chain(), "event", { filter: { field: "source", op: "eq", value: "vyre" }, page: { limit: 200 } });
      const rows = new Map([...page.rows, ...fresh.rows].map((/** @type {any} */ r) => [r.id, r]));
      for (const r of rows.values()) {
        const mine = synced()[r.id];
        const isNew = !r.data.external_id;
        if (!isNew && mine && mine.version === r.version) continue; // nothing changed here since the last sync
        if (!isNew && !mine) continue; // a record we never synced and did not make: leave it
        if (r.data.source === "google" && !mine) continue;
        const change = { op: /** @type {"insert" | "patch"} */ (isNew ? "insert" : "patch"), record: r.urn ?? `${r.type}/${r.id}`, title: String(r.data.title) };
        if (!(await allowed(change))) { out.refused++; report("calendar.refused", change); continue; }
        if (isNew) {
          const res = await o.request({ method: "POST", url: `${API}/calendars/${cal}/events`, body: toGoogle(r.data) });
          if (res.status !== 200) throw Object.assign(new Error(`the calendar answered ${res.status}`), { code: "unavailable" });
          const u = await R.update(o.chain(), "event", r.id, { external_id: res.body.id, calendar: route, source: "vyre" }, r.version);
          mark(u.id, { version: u.version, etag: res.body.etag }); out.inserted++;
        } else {
          const res = await o.request({ method: "PATCH", url: `${API}/calendars/${cal}/events/${encodeURIComponent(r.data.external_id)}`, body: toGoogle(r.data), headers: { "If-Match": mine.etag } });
          if (res.status === 412) { out.conflicts++; report("calendar.conflict", change); mark(r.id, { version: r.version, conflict: true }); continue; }
          if (res.status !== 200) throw Object.assign(new Error(`the calendar answered ${res.status}`), { code: "unavailable" });
          mark(r.id, { version: r.version, etag: res.body.etag }); out.patched++;
        }
      }
      // a conflict is marked: the next pull brings the outside copy over this one
      return out;
    });
  }

  return { pull, push, sync: async () => ({ pulled: await pull(), pushed: await push() }) };
}
