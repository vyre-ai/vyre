// @ts-check
// ops-tool: the `chrome.op` tool. Learned website operations from an agent's side: scout a page, teach an operation, keep it, call it by name, repair it, roll it back.
//
// The login stays in the extension: every request is built and signed inside the person's page (extension/caps/ops.js), and what comes back here is extracted data or a plain verdict.
// This file is the memory and the manners around that: where operations are kept (the one site record: Vyre Memory, or files in standalone), the draft that waits for a proof, the
// reactive repair after a drift, and who may remove one. A send or a change is held by the same Gate as every other outward act, because the extension returns it as held and
// dispatch() files it.

import crypto from "node:crypto";

const isObj = (/** @type {any} */ v) => v && typeof v === "object" && !Array.isArray(v);
const DRAFT_TTL_MS = 60 * 60_000;
const MAX_DRAFTS = 20;

/**
 * @param {{ dispatch: (op: string, args: any, meta: any) => Promise<any>, call: (tool: string, input: any) => Promise<any>, originOf: (u: string) => string, isPerson: (meta: any) => boolean,
 *   denied: (code: string, message: string) => Error, urls: Map<number, string> }} d
 */
export function createOpsTool({ dispatch, call, originOf, isPerson, denied, urls }) {
  /** @type {Map<string, { operation: any, origin: string, examples: any[], at: number }>} */
  const drafts = new Map();
  const data = (/** @type {any} */ r) => (r && !r.error ? r.data : null);

  /** @param {any} i */
  const siteOf = i => {
    const o = typeof i.site === "string" ? originOf(i.site) || (/^https?:\/\/[^/\s]+$/.test(i.site) ? i.site : "") : Number.isInteger(i.tab) ? originOf(urls.get(i.tab) || "") : "";
    if (!o) throw denied("bad_request", "name the site: site is an origin such as https://app.example.com (or pass a tab that is on it)");
    return o;
  };

  /** The operations stored for a site, in full. @param {string} origin */
  async function stored(origin) {
    const r = data(await call("memory.site.get", { origin, parts: ["ops"] }));
    return { ops: (r && r.origin && Array.isArray(r.origin.ops) ? r.origin.ops : []), rev: r && r.rev ? r.rev : 0 };
  }

  /** A tab on the site: the one asked for, else the person's tab on it, opened if there is none. @param {any} i @param {string} origin @param {any} m */
  async function tabFor(i, origin, m) {
    if (Number.isInteger(i.tab)) return i.tab;
    const r = await dispatch("tabs.use", { url: origin, openIfMissing: true }, m);
    const t = isObj(r) && isObj(r.tab) ? r.tab : r;
    if (!t || !Number.isInteger(t.id)) throw denied("no_tab", `no tab on ${origin}: open the site in Chrome first`);
    return t.id;
  }

  /** @param {any} op */
  const summary = op => {
    let where = ""; try { const u = new URL(op.request.url); where = `${op.request.method} ${u.host}${u.pathname}`; } catch { where = op.request.method; }
    const refs = [...new Set(op.slots.filter((/** @type {any} */ s) => s.ref).map((/** @type {any} */ s) => String(s.ref).replace(/@.*$/, "")))];
    return { name: op.name, kind: op.kind, inputs: op.params.map((/** @type {any} */ p) => ({ name: p.name, type: p.type, required: p.required })), request: where,
      bound: op.slots.filter((/** @type {any} */ s) => s.param !== undefined).map((/** @type {any} */ s) => ({ input: s.param, at: s.at.join(" > ") })), signedWith: refs, rungs: op.rungs,
      needsThePage: op.minTier === 3, login: op.login === true, answer: { format: op.response.format, ...(op.response.extract !== undefined ? { extract: op.response.extract } : {}) } };
  };

  const putOp = async (/** @type {string} */ origin, /** @type {any} */ entry) => data(await call("memory.site.put", { origin, target: "origin", patch: { key: origin, ops: [entry] } }));
  const report = async (/** @type {string} */ origin, /** @type {string} */ name, /** @type {"ok"|"miss"} */ outcome, /** @type {string} */ cls) => {
    // The class rides in a put so the Connection's light can show it; the count is the store's own.
    await call("memory.site.report", { origin, part: "ops", id: name, outcome }).catch(() => null);
    void cls;
  };

  /** @param {any} i @param {any} m */
  async function run(i, m) {
    const action = String(i.action || "");
    const now = Date.now();
    for (const [k, v] of drafts) if (now - v.at > DRAFT_TTL_MS) drafts.delete(k);

    if (action === "list") {
      const origin = siteOf(i);
      const r = data(await call("memory.site.get", { origin }));
      const ops = r && r.origin && Array.isArray(r.origin.ops) ? r.origin.ops : [];
      return { site: origin, operations: ops, ...(ops.length ? {} : { note: "nothing is kept for this site yet; scout the page, then learn an operation" }) };
    }

    if (action === "scout") {
      const tab = await tabFor(i, siteOf(i), m);
      return dispatch("ops.scout", { tab, examples: isObj(i.examples) ? i.examples : (Array.isArray(i.examples) && isObj(i.examples[0]) ? i.examples[0] : {}), limit: i.limit }, m);
    }

    if (action === "learn") {
      const origin = siteOf(i);
      const tab = await tabFor(i, origin, m);
      const res = await dispatch("ops.learn", { tab, name: i.name, kind: i.kind || "read", trigger: i.trigger, examples: i.examples, ...(i.match ? { match: i.match } : {}), ...(Number.isInteger(i.id) ? { id: i.id } : {}), ...(Array.isArray(i.public) ? { public: i.public } : {}) }, m);
      if (!isObj(res) || res.held || !res.ok || !res.operation) return res;
      const id = "d" + crypto.randomBytes(5).toString("hex");
      drafts.set(id, { operation: res.operation, origin, examples: Array.isArray(i.examples) ? i.examples : [], at: now });
      while (drafts.size > MAX_DRAFTS) drafts.delete(/** @type {string} */ (drafts.keys().next().value));
      const readOp = res.operation.kind === "read";
      return { draft: id, ...summary(res.operation), warnings: res.warnings, next: readOp
        ? `prove it: call chrome_op save with draft ${id} and verify = an input that was NOT one of your examples; it is kept only if that answers`
        : `a ${res.operation.kind} is kept without being run: call chrome_op save with draft ${id}; every later call waits for the person's yes` };
    }

    if (action === "save") {
      const d = drafts.get(String(i.draft || ""));
      if (!d) throw denied("not_found", "no such draft (it expires after an hour); learn the operation again");
      const op = d.operation;
      let outcome;
      if (op.kind === "read") {
        if (!isObj(i.verify)) throw denied("bad_request", "a read is kept only after it answers on an input that was not an example: pass verify = { input: value }");
        const ex = JSON.stringify(d.examples).toLowerCase();
        for (const v of Object.values(i.verify)) if (ex.includes(JSON.stringify(v).toLowerCase().slice(1, -1)) && String(v).length >= 3) throw denied("bad_request", "verify must differ from the examples: an example proves nothing about an input nobody showed it");
        const tab = await tabFor(i, d.origin, m);
        const r = await dispatch("ops.call", { tab, op, inputs: i.verify }, m);
        if (!isObj(r) || r.held) return r;
        const empty = r.data === undefined || r.data === null || (Array.isArray(r.data) && r.data.length === 0) || (isObj(r.data) && Object.keys(r.data).length === 0);
        if (!r.ok || empty) return { saved: false, reason: r.ok ? "the proof answered, but with no data" : `the proof did not answer: ${r.reason || r.class}`, class: r.class, next: r.next || "check the answer's extract and pick, or learn it again with a better example", result: r };
        outcome = "ok";
      }
      const put = await putOp(d.origin, { name: op.name, kind: op.kind, op, ...(outcome ? { outcome } : {}) });
      if (!put || !put.accepted) return { saved: false, reason: put && put.learning === false ? "learning is switched off" : "the site record refused it", ...(put && put.refused ? { refused: put.refused } : {}) };
      drafts.delete(String(i.draft));
      return { saved: true, name: op.name, kind: op.kind, site: d.origin, rev: put.rev };
    }

    if (action === "call") {
      const origin = siteOf(i);
      const { ops } = await stored(origin);
      const entry = ops.find((/** @type {any} */ o) => o.name === i.name);
      if (!entry) throw denied("not_found", `no operation ${String(i.name || "").slice(0, 40)} for ${origin}; known: ${ops.map((/** @type {any} */ o) => o.name).join(", ") || "none"}`);
      const tab = await tabFor(i, origin, m);
      const inputs = isObj(i.inputs) ? i.inputs : {};
      let res = await dispatch("ops.call", { tab, op: entry.op, inputs, ...(i.maxChars ? { maxChars: i.maxChars } : {}) }, m);
      if (!isObj(res) || res.held) return res;
      if (res.ok) { await report(origin, entry.name, "ok", "ok"); return res; }
      // Reactive repair, reads only: the stored template is always tried first; only a drift triggers a relearn, and the repair is kept only after a replay answers.
      if (res.class === "drift" && entry.kind === "read" && i.heal !== false) {
        const h = await dispatch("ops.heal", { tab, op: entry.op, inputs }, m);
        if (isObj(h) && h.outcome === "healed" && h.operation) {
          await putOp(origin, { name: entry.name, kind: entry.kind, op: h.operation, outcome: "ok" });
          const again = await dispatch("ops.call", { tab, op: h.operation, inputs }, m);
          if (isObj(again) && again.ok) return { ...again, healed: true };
        }
        await report(origin, entry.name, "miss", "drift");
        return { ...res, heal: isObj(h) ? { outcome: h.outcome, reason: h.reason } : undefined, next: "could not repair automatically: teach it again with chrome_op learn" };
      }
      if (res.class === "drift") await report(origin, entry.name, "miss", "drift");
      return res;
    }

    if (action === "heal") {
      const origin = siteOf(i);
      const { ops } = await stored(origin);
      const entry = ops.find((/** @type {any} */ o) => o.name === i.name);
      if (!entry) throw denied("not_found", `no operation ${String(i.name || "").slice(0, 40)} for ${origin}`);
      const tab = await tabFor(i, origin, m);
      const h = await dispatch("ops.heal", { tab, op: entry.op, inputs: isObj(i.inputs) ? i.inputs : {}, ...(isObj(i.verify) ? { verifyInputs: i.verify } : {}), force: i.force === true }, m);
      if (isObj(h) && h.outcome === "healed" && h.operation) { const saved = await putOp(origin, { name: entry.name, kind: entry.kind, op: h.operation, outcome: "ok" }); return { outcome: "healed", reason: h.reason, kept: !!(saved && saved.accepted) }; }
      return h;
    }

    if (action === "check") {
      const origin = siteOf(i);
      const { ops } = await stored(origin);
      const entry = ops.find((/** @type {any} */ o) => o.name === i.name);
      if (!entry) throw denied("not_found", `no operation ${String(i.name || "").slice(0, 40)} for ${origin}`);
      return dispatch("ops.check", { tab: await tabFor(i, origin, m), op: entry.op }, m);
    }

    if (action === "versions") {
      const origin = siteOf(i);
      const { ops } = await stored(origin);
      const entry = ops.find((/** @type {any} */ o) => o.name === i.name);
      if (!entry) throw denied("not_found", `no operation ${String(i.name || "").slice(0, 40)} for ${origin}`);
      return { name: entry.name, current: entry.version, history: (entry.prev || []).map((/** @type {any} */ p) => ({ version: p.version, replacedAt: p.at })) };
    }

    if (action === "rollback" || action === "forget") {
      if (!isPerson(m)) throw denied("denied", `only the person ${action === "forget" ? "removes" : "rolls back"} an operation`);
      const origin = siteOf(i);
      if (action === "rollback") {
        const r = data(await call("memory.site.rollback", { origin, name: String(i.name || ""), version: Number(i.version) }));
        if (!r || !r.rolledBack) return { rolledBack: false, reason: "that version is not held (see action versions)" };
        return { rolledBack: true, name: i.name, version: r.version };
      }
      const { rev } = await stored(origin);
      const r = data(await call("memory.site.put", { origin, target: "origin", base_rev: rev, patch: { key: origin, remove: [{ part: "ops", id: String(i.name || "") }] } }));
      return { forgotten: !!(r && r.accepted), name: i.name };
    }

    throw denied("bad_request", "action is one of list, scout, learn, save, call, heal, check, versions, rollback, forget");
  }

  return { run, drafts };
}
