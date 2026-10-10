// @ts-check
// site: Connections to websites, signed in through a browser. The learned operations of a site (lib/siteops, kept in the one site record) become the operations of a Connection, so Flows,
// watchers, views and assistants call them like any other Connection's, a send is held at the Gate, and the Connection has a light. Where the call goes is the only difference: not over HTTP with
// a key but into a browser that is signed in. The login never reaches Vyre.
//
// How a call travels: a Flow step (or a view, or an assistant through connectors.operation.run) addresses the Connection's virtual route; the vault judges it as it judges every request (the
// route rules, its class, the Gate's hold and approval); then, instead of making an HTTP request, it hands the call to `connectors.site.run`, here, which picks the rung (the way to a browser
// that holds the login) and runs the operation there. Rung "page" is the person's own Chrome on this machine (chrome.op.run).

import { operationOf } from "../../records/connectors/site.js";
import { createGovernor, settingsOf, isChallenge } from "./governor.js";
import { runOperation } from "../../lib/siteops/run.js";
import { readOnly } from "../../lib/siteops/spec.js";

/** @typedef {import("../../records/connectors/format.js").Declaration} Declaration */

const STATUS_OF = /** @type {Record<string, number>} */ ({ input: 400, auth: 401, blocked: 403, rate: 429, drift: 502, error: 502, held: 409 });

/**
 * Said in plain words, per class, for the Connection's light.
 * @param {string} cls @param {string} host @param {string} [reason] @param {string} [agent] whose computer holds the login, when it is a box's
 */
export function lightFor(cls, host, reason, agent = "") {
  switch (cls) {
    case "ok": return { light: "green", words: "connected", cls: "ok" };
    case "auth": return { light: "red", words: `sign in to ${host} again in the browser Vyre uses${agent ? ` (${agent}'s computer: open its screen and sign in once)` : ""}`, cls };
    case "blocked": return { light: "red", words: `${host} is challenging the browser: a person has to clear it once`, cls };
    case "rate": return { light: "red", words: `${host} says to slow down`, cls };
    case "drift": return { light: "red", words: `${host} changed and the operation could not be repaired: teach it again`, cls };
    case "no_browser": return reason && /^needs your Chrome/.test(reason) ? { light: "red", words: reason, cls } : { light: "red", words: `no signed-in browser is connected: open Chrome with Vyre Computer${host ? ` and sign in to ${host}` : ""}`, cls };
    default: return { light: "red", words: `the last call did not work${reason ? `: ${String(reason).slice(0, 120)}` : ""}`, cls: "error" };
  }
}

/**
 * The runner: picks a rung and runs one operation there.
 * @param {{ call: (tool: string, input: any, opts?: any) => Promise<any>, made: any, emit?: (type: string, payload: any) => void, log?: (m: string, x?: any) => void,
 *   entries?: (origin: string, names?: string[]) => Promise<{ name: string, kind: string, op: any }[]>, role?: string, governor?: ReturnType<typeof createGovernor>, sleep?: (ms: number) => Promise<void> }} deps
 */
export function createSiteRunner({ call, made, emit = () => {}, log = () => {}, entries, role = "local", governor, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  /** Calls to one account go one at a time, in the order they came. @type {Map<string, Promise<any>>} */
  const chains = new Map();
  /** @template T @param {string} id @param {() => Promise<T>} fn @returns {Promise<T>} */
  const serial = (id, fn) => {
    const p = (chains.get(id) || Promise.resolve()).catch(() => {}).then(fn);
    chains.set(id, p);
    return p.finally(() => { if (chains.get(id) === p) chains.delete(id); });
  };
  /** One rung. Today: this machine's Chrome. @param {string} origin @param {string} name @param {Record<string, any>} inputs @param {boolean} approved @param {boolean} [check] */
  async function pageRung(origin, name, inputs, approved, check = false, agent = "") {
    // on a box the same tool runs the operation in an agent's own Chrome (rung "box"): `agent` says whose computer holds the login
    const r = await call("chrome.op.run", { site: origin, name, inputs, approved, ...(agent ? { agent } : {}), ...(check ? { check: true } : {}) });
    if (r && r.error) {
      const code = String(r.error.code || "");
      if (/no_such_tool|no tool|unavailable|no_extension|no_tab|not connected/i.test(`${code} ${r.error.message}`)) return { class: "no_browser", reason: String(r.error.message || code) };
      return { class: "error", reason: String(r.error.message || code) };
    }
    return r.data;
  }

  /**
   * Rung "mac": a box asks the person's own Chrome on a paired Mac, through the link (named, person-approved operations only). A read runs at once; an outward call carries the box's signed
   * assertion. When no Mac is on, the answer says so and the Connection says it needs the person's Chrome.
   * @param {string} origin @param {string} name @param {Record<string, any>} inputs @param {boolean} approved
   */
  async function macRung(origin, name, inputs, approved, kind = "read") {
    // Only a read goes as chrome.op.call; every other kind goes as chrome.op.send, with the person's approval.
    const sends = kind !== "read";
    const r = await call("link.macs.call", { tool: sends ? "chrome.op.send" : "chrome.op.call", input: sends ? { site: origin, name, inputs, approved } : { site: origin, name, inputs }, timeout: 15_000 });
    if (r && r.error) return { class: "no_browser", reason: String(r.error.message || r.error.code) };
    const answers = Array.isArray(r.data) ? r.data : [];
    const ok = answers.find((/** @type {any} */ a) => a && a.ok);
    if (ok) return ok.data;
    const first = answers[0];
    if (!first) return { class: "no_browser", reason: "no Mac is paired with this box" };
    const code = first.error && first.error.code;
    if (code === "mac_offline" || code === "timeout") return { class: "no_browser", reason: `needs your Chrome: the Mac "${first.name || "paired Mac"}" is ${code === "timeout" ? "not answering" : "offline"}`, mac: true };
    if (code === "denied") return { class: "no_browser", reason: String(first.error && first.error.message || "the Mac has not allowed this operation for the box"), mac: true };
    return { class: "error", reason: String(first.error && first.error.message || "the Mac could not run it") };
  }

  /**
   * Rung "public": a plain GET from here, for an operation that needs no login (public data). Runs 24/7 with no browser. The vault fetches it (private ranges refused at every hop, a size cap, no
   * cookie, no credential of ours), and the same run, classify, extract and cap as any rung judges the answer.
   * @param {any} op @param {Record<string, any>} inputs
   */
  async function publicRung(op, inputs) {
    return runOperation(op, inputs, { send: async req => {
      const r = await call("vault.fetch.public", { url: req.url, raw: true });
      if (r && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return { status: r.data.status, headers: { "content-type": r.data.type || "" }, body: r.data.body };
    } });
  }

  /** Which rungs this machine can try for an operation, cheapest first: public (no browser, any time), then a browser that holds the login. @param {any} op */
  function ladder(op, agent = "") {
    const allowed = Array.isArray(op && op.rungs) && op.rungs.length ? op.rungs : ["page"];
    /** @type {string[]} */ const out = [];
    if (allowed.includes("public") && op.login === false && readOnly(op) && String(op.request.method).toUpperCase() === "GET") out.push("public");
    if (allowed.includes("page") && role !== "box") out.push("page");
    // the agent's own Chrome on a box: the login lives in that computer's profile, so it runs with the Mac off
    if (allowed.includes("box") && role === "box" && agent) out.push("box");
    // the person's own Chrome on a paired Mac, asked through the link
    if (allowed.includes("mac") && role === "box") out.push("mac");
    return out;
  }

  /**
   * @param {{ credential: string, method: string, path: string, query?: any, body?: any, approved?: boolean }} q
   * @returns {Promise<{ status: number, data: any }>}
   */
  async function runOnce(q) {
    const id = String(q.credential || "").replace(/^conn-/, "");
    const row = made.row(id);
    if (!row) return { status: 404, data: { error: { class: "input", reason: "no such Connection" } } };
    /** @type {Declaration} */ const decl = JSON.parse(row.declaration);
    if (decl.transport !== "site") return { status: 400, data: { error: { class: "input", reason: "not a website Connection" } } };
    const op = operationOf(decl, q);
    if (!op) return { status: 404, data: { error: { class: "input", reason: "that route is not one of the Connection's operations" } } };
    const host = new URL(/** @type {string} */ (decl.base_url)).hostname;
    // the rungs, cheapest that works first; a rung that cannot serve (no browser, not allowed here) hands on to the next, and the event says which one answered
    const entry = entries ? (await entries(/** @type {string} */ (decl.base_url), [op.name]).catch(() => [])).find(e => e.name === op.name) : undefined;
    /** @type {{ agent?: string, governor?: any }} */ const form = (() => { try { return JSON.parse(row.form || "{}"); } catch { return {}; } })();
    const agent = typeof form.agent === "string" ? form.agent : "";
    // a watched account is used at a person's pace, within its limits, one call at a time (governor.js); a public fetch touches no account
    const limits = governor ? settingsOf(host, form.governor) : null;
    const rungs = entry ? ladder(entry.op, agent) : ["page"];
    /** @type {any} */ let res = null; let rung = "";
    if (!rungs.length) res = { class: "no_browser", reason: "no browser that holds this login is reachable from this machine" };
    for (const r of rungs) {
      rung = r;
      if (limits && governor && r !== "public") {
        const a = governor.admit({ id, kind: op.kind, settings: limits });
        if (!a.ok) { res = { class: a.class, reason: a.reason, governed: true }; break; }
        if (a.waitMs > 0) await sleep(a.waitMs);
      }
      res = r === "public" && entry ? await publicRung(entry.op, op.inputs) : r === "mac" ? await macRung(/** @type {string} */ (decl.base_url), op.name, op.inputs, q.approved === true, op.kind) : await pageRung(/** @type {string} */ (decl.base_url), op.name, op.inputs, q.approved === true, false, r === "box" ? agent : "");
      if (limits && governor && r !== "public" && res) {
        const rc = res.ok ? "ok" : String(res.class || "error");
        const rec = governor.record({ id, kind: op.kind, settings: limits, cls: rc, reason: res.reason });
        if (rec.stopped && isChallenge(rc, res.reason)) emit("connectors.site-stopped", { id, site: decl.base_url, host, reason: String(res.reason || "").slice(0, 160) });
      }
      // a rung that has no browser to offer, or a public fetch the site refused, is not the answer while another rung remains
      if (res && (res.class === "no_browser" || (r === "public" && !res.ok && (res.class === "auth" || res.class === "blocked")))) continue;
      break;
    }
    const cls = res && res.ok ? "ok" : String((res && res.class) || "error");
    emit("connectors.site-ran", { id, op: op.name, rung, class: cls });
    if (cls !== "held") {
      const l = lightFor(cls, host, res && res.reason, rung === "box" ? agent : "");
      made.touch(id, l.light, l.words, l.cls);
      emit("connectors.connection-checked", { id, light: l.light });
      if (cls === "auth") emit("connectors.site-needs-signin", { id, site: decl.base_url, host, rung, ...(rung === "box" && agent ? { agent } : {}) });
    }
    if (res && res.mac && cls === "no_browser") emit("connectors.site-needs-browser", { id, site: decl.base_url, host, rung: "mac", reason: String(res.reason || "") });
    if (cls === "ok") return { status: 200, data: res.data === undefined ? null : res.data };
    log("site operation did not answer", { id, op: op.name, class: cls });
    const status = cls === "no_browser" ? 503 : STATUS_OF[cls] || 502;
    return { status, data: { error: { class: cls, reason: res && res.reason ? String(res.reason) : cls, ...(res && res.mac ? { mac: true } : {}), ...(res && res.next ? { next: String(res.next) } : {}) } } };
  }

  /** @param {{ credential: string, method: string, path: string, query?: any, body?: any, approved?: boolean }} q */
  const run = q => serial(String(q.credential || "").replace(/^conn-/, ""), () => runOnce(q));

  /** Can the browser sign for this Connection right now (the right site is open, the references resolve)? @param {string} id */
  async function check(id) {
    const row = made.row(id);
    if (!row) throw Object.assign(new Error(`no connection ${id} (connectors.site.list shows the website Connections)`), { code: "not_found" });
    /** @type {Declaration} */ const decl = JSON.parse(row.declaration);
    const host = new URL(/** @type {string} */ (decl.base_url)).hostname;
    const first = Object.values(decl.ops).find(o => o.site);
    if (!first || !first.site) return { light: "red", words: "no operations are kept for this site yet" };
    // on a box the browser that holds the login is an agent's computer (the Connection's agent); a Mac is asked only when a call needs it, never to "check"
    /** @type {{ agent?: string }} */ const form = (() => { try { return JSON.parse(row.form || "{}"); } catch { return {}; } })();
    const agent = typeof form.agent === "string" ? form.agent : "";
    if (role === "box" && !agent) return { light: "red", words: `no agent's computer is named to hold the login for ${host}: name one when you connect it, or run it from your Mac`, cls: "no_browser" };
    const res = await pageRung(/** @type {string} */ (decl.base_url), first.site.name, {}, false, true, role === "box" ? agent : "");
    if (res && res.class === "no_browser") return lightFor("no_browser", host);
    if (res && res.onSite === false) return { light: "red", words: `open ${host} in Chrome first`, cls: "no_browser" };
    return res && res.ok ? { light: "green", words: "signed in and ready", cls: "ok" } : lightFor("auth", host);
  }

  return { run, check };
}

/** The learned operations a site record holds, in full, as { name, kind, op, version, ... } items. @param {(tool: string, input: any) => Promise<any>} call @param {string} origin */
async function recordOps(call, origin) {
  const r = await call("memory.site.get", { origin, parts: ["ops"] });
  if (r && r.error) throw Object.assign(new Error(`could not read what is known about ${origin}: ${r.error.message}`), { code: r.error.code || "failed" });
  const d = r && r.data;
  return /** @type {any[]} */ (d && d.origin && Array.isArray(d.origin.ops) ? d.origin.ops : []);
}

/**
 * The learned operations of a site as { name, kind, op } entries, all or the named ones; refuses a name the site does not hold and a site that holds none.
 * @param {(tool: string, input: any) => Promise<any>} call @returns {(origin: string, names?: string[]) => Promise<{ name: string, kind: string, op: any }[]>}
 */
export function siteEntriesFrom(call) {
  return async (origin, names) => {
    const ops = await recordOps(call, origin);
    const chosen = Array.isArray(names) && names.length ? ops.filter(o => names.includes(o.name)) : ops;
    const missing = Array.isArray(names) ? names.filter(n => !ops.some(o => o.name === n)) : [];
    const fail = (/** @type {string} */ m, /** @type {string} */ c) => Object.assign(new Error(m), { code: c });
    if (missing.length) throw fail(`no kept operation ${missing.map(m => String(m).slice(0, 40)).join(", ")}; the site has ${ops.map(o => o.name).join(", ") || "none"}`, "not_found");
    if (!chosen.length) throw fail("nothing has been taught for this site yet: teach an operation with chrome_op learn, then connect it", "not_found");
    return chosen.map(o => ({ name: o.name, kind: o.kind, op: o.op }));
  };
}

/**
 * The tools of a site Connection. Connecting and syncing widen what a Connection reaches, so they are the person's own acts; the list is open to readers; `run` is the vault's alone.
 * @param {any} ctx @param {{ made: any, runner: ReturnType<typeof createSiteRunner>, governor: ReturnType<typeof createGovernor>, yours: (meta: any, what: string) => string, fail: (m: string, c?: string) => Error, obj: Function, str: any, people: string[], readers: string[] }} d
 */
export function registerSiteTools(ctx, { made, runner, governor, yours, fail, obj, str, people, readers }) {
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ opts) => ctx.call(tool, input, opts);
  /** The entries of the chosen operations, or all. @param {any[]} ops @param {string[] | undefined} names */
  const pick = (ops, names) => {
    const chosen = Array.isArray(names) && names.length ? ops.filter(o => names.includes(o.name)) : ops;
    const missing = Array.isArray(names) ? names.filter(n => !ops.some(o => o.name === n)) : [];
    if (missing.length) throw fail(`no kept operation ${missing.map(m => String(m).slice(0, 40)).join(", ")}; the site has ${ops.map(o => o.name).join(", ") || "none"}`, "not_found");
    if (!chosen.length) throw fail("nothing has been taught for this site yet: teach an operation with chrome_op learn, then connect it", "not_found");
    return chosen.map(o => ({ name: o.name, kind: o.kind, op: o.op }));
  };
  const originOf = (/** @type {string} */ s) => { try { const u = new URL(String(s)); if (u.protocol !== "https:") throw new Error("x"); return u.origin; } catch { throw fail("site is a website's origin, such as https://app.example.com", "bad_input"); } };

  ctx.tool("connectors.site.connect", {
    effect: "write", callers: people,
    description: "Make a website a Connection from the operations Vyre has learned on it: { site (origin), label, id?, operations? (names; default all), polls? (reads a watcher may poll) }. Flows, watchers and assistants then call those operations like any Connection's, a send waits for your yes, and the login stays in the browser. Your own act: it decides what the Connection can reach.",
    input: obj({ site: str, label: str, id: str, agent: { type: "string", description: "On a box: whose computer's Chrome holds the login (it runs the operations 24/7, with the Mac off)." }, operations: { type: "array", items: str }, polls: { type: "array", description: "Reads a watcher may poll: [{ name, operation, id (path of an item's own id), items?, title?, at?, args?, every_minutes? }]." } }, ["site", "label"]),
    run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
      const as = yours(meta, "connect a website");
      const origin = originOf(input.site);
      const entries = pick(await recordOps(call, origin), input.operations);
      return made.saveSite({ id: input.id, label: String(input.label), origin, entries, ...(Array.isArray(input.polls) ? { polls: input.polls } : {}), ...(input.agent ? { agent: String(input.agent) } : {}) }, { as });
    },
  });

  ctx.tool("connectors.site.propose", {
    effect: "write", callers: [...people, "module", "mcp", "harness"],
    description: "Propose a website Connection from what Vyre learned on the site: { site, label } -> { proposal, card }. Nothing runs until approved.",
    input: obj({ site: str, label: str, id: str, operations: { type: "array", items: str }, polls: { type: "array" }, why: str }, ["site", "label"]),
    run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
      const origin = originOf(input.site);
      return made.proposeSite({ ...input, site: origin }, String(meta && meta.caller || "").slice(0, 80), input.why ? String(input.why) : undefined);
    },
  });

  ctx.tool("connectors.site.sync", {
    effect: "write", callers: people,
    description: "Bring a website Connection up to date with what Vyre has learned on the site: { id, operations? }. New or repaired operations appear; the shapes a Flow is checked against change with them. Your own act.",
    input: obj({ id: str, agent: str, operations: { type: "array", items: str } }, ["id"]),
    run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
      const as = yours(meta, "change a website connection");
      const r = made.row(String(input.id));
      if (!r) throw fail(`no connection ${String(input.id).slice(0, 40)}`, "not_found");
      const d = JSON.parse(r.declaration);
      if (d.transport !== "site") throw fail(`${r.id} is not a website connection`, "bad_input");
      const entries = pick(await recordOps(call, d.base_url), Array.isArray(input.operations) ? input.operations : Object.values(d.ops).map((/** @type {any} */ o) => o.site && o.site.name).filter(Boolean));
      return made.saveSite({ id: r.id, label: r.label, origin: d.base_url, entries, ...(input.agent !== undefined ? { agent: String(input.agent) } : {}) }, { as, replace: true });
    },
  });

  ctx.tool("connectors.site.operations", {
    effect: "read", callers: [...people, "module", "mcp", "harness"],
    description: "A website Connection's operations with version, health and version history: { id } -> { site, light, reason, operations }.",
    input: obj({ id: str }, ["id"]),
    run: async (/** @type {any} */ input) => {
      const r = made.row(String(input.id));
      if (!r) throw fail(`no connection ${String(input.id).slice(0, 40)}`, "not_found");
      const d = JSON.parse(r.declaration);
      if (d.transport !== "site") throw fail(`${r.id} is not a website connection`, "bad_input");
      const have = await recordOps(call, d.base_url);
      const host = new URL(d.base_url).hostname;
      const operations = Object.values(d.ops).map((/** @type {any} */ o) => {
        const e = have.find(x => x.name === o.site.name);
        const cls = e && e.lastClass ? e.lastClass : "";
        const l = cls ? lightFor(cls, host) : null;
        return { name: o.site.name, kind: o.kind, inputs: Object.keys((o.input && (o.input.query || o.input.body)) || {}), version: e ? e.version : null, health: e ? (cls === "ok" || !cls ? "ok" : cls) : "removed", ...(l && cls !== "ok" ? { says: l.words } : {}),
          history: e && e.prev ? e.prev.map((/** @type {any} */ p) => ({ version: p.version, replacedAt: p.at })) : [], stale: e ? false : true };
      });
      return { id: r.id, site: d.base_url, light: r.light, reason: r.reason, operations };
    },
  });

  /** @param {any} r @param {any} d */
  const siteRow = (r, d) => ({ id: r.id, title: r.label, subtitle: r.reason || new URL(d.base_url).hostname, light: r.light, site: d.base_url, operations: Object.keys(d.ops).length });
  const siteRows = () => /** @type {any[]} */ (ctx.store.db.prepare("SELECT * FROM connectors_made ORDER BY label").all()).map(r => ({ r, d: JSON.parse(r.declaration) })).filter(x => x.d.transport === "site");

  ctx.tool("connectors.site.list", {
    effect: "read", callers: [...people, "module", "mcp", "harness"],
    description: "The website Connections, one row each: { sites: [{ id, title, subtitle, light, site, operations }] }.",
    input: obj({}, []),
    run: async () => ({ sites: siteRows().map(({ r, d }) => siteRow(r, d)) }),
  });

  /** The classes of a red light that only a person can clear: the login ran out, the site wants a person's check, or no browser holds the login. */
  const NEEDS_PERSON = new Set(["auth", "blocked", "no_browser"]);
  ctx.tool("connectors.site.attention", {
    effect: "read", callers: [...people, "module", "mcp", "harness"],
    description: "Website Connections that wait for a person (login out, security check, no browser): { sites: [{ id, host, class, words, agent? }] }.",
    input: obj({}, []),
    run: async () => ({ sites: siteRows().filter(({ r }) => r.light === "red").map(({ r, d }) => {
      /** @type {any} */ const form = (() => { try { return JSON.parse(r.form || "{}"); } catch { return {}; } })();
      const cls = form.last && form.last.class ? String(form.last.class) : "";
      if (!NEEDS_PERSON.has(cls)) return null;
      const host = new URL(d.base_url).hostname;
      const stopped = cls === "blocked" && governor ? Boolean(governor.usage(r.id, settingsOf(host, form.governor)).stopped) : false;
      return { id: r.id, title: r.label, host, site: d.base_url, class: cls, words: r.reason || "", ...(typeof form.agent === "string" && form.agent ? { agent: form.agent } : {}), ...(stopped ? { stopped: true } : {}), at: r.checked_at || 0 };
    }).filter(Boolean) }),
  });

  ctx.tool("connectors.site.rows", {
    effect: "read", callers: [...people, "module", "mcp", "harness"],
    description: "Every operation of every website Connection, one row each: { rows: [{ id, title, subtitle, accessory, site, version, kept }] }.",
    input: obj({}, []),
    run: async () => {
      const rows = [];
      for (const { r, d } of siteRows()) {
        let have = [];
        try { have = await recordOps(call, d.base_url); } catch { /* the site record is not readable: the rows say removed */ }
        for (const o of Object.values(d.ops)) {
          const e = have.find(x => x.name === o.site.name);
          const cls = e && e.lastClass ? e.lastClass : "";
          rows.push({ id: `${r.id}:${o.site.name}`, title: o.site.name, subtitle: `${r.label} · ${o.kind}${e ? ` · v${e.version}` : ""}`, accessory: e ? (!cls || cls === "ok" ? "ok" : cls) : "removed", site: d.base_url, version: e ? e.version : null, kept: e && e.prev ? e.prev.length : 0 });
        }
      }
      return { rows };
    },
  });

  ctx.tool("connectors.site.limits", {
    effect: "read", callers: [...people, "module", "mcp", "harness"],
    description: "A website account's limits and today's use: { id } -> { settings, usage }. Null settings means nothing governs it.",
    input: obj({ id: str }, ["id"]),
    run: async (/** @type {any} */ input) => {
      const r = made.row(String(input.id));
      if (!r) throw fail(`no connection ${String(input.id).slice(0, 40)}`, "not_found");
      const d = JSON.parse(r.declaration);
      if (d.transport !== "site") throw fail(`${r.id} is not a website connection`, "bad_input");
      const form = r.form ? JSON.parse(r.form) : {};
      const settings = settingsOf(new URL(d.base_url).hostname, form.governor);
      return { id: r.id, settings, ...(settings ? { usage: governor.usage(r.id, settings) } : {}) };
    },
  });

  ctx.tool("connectors.site.limits.set", {
    effect: "write", callers: people,
    description: "Set the limits of a website account: { id, settings: { profile?: strict | none, reads_per_day?, writes_per_day?, gap_read_s?: [min, max], gap_write_s?: [min, max], quiet?: { from, to } | null, cooldown_min?, tz? } }, or settings null to go back to the site's default. Your own act: these protect your own account.",
    input: obj({ id: str, settings: {} }, ["id", "settings"]),
    run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
      yours(meta, "change the limits of a website account");
      const r = made.row(String(input.id));
      if (!r) throw fail(`no connection ${String(input.id).slice(0, 40)}`, "not_found");
      if (JSON.parse(r.declaration).transport !== "site") throw fail(`${r.id} is not a website connection`, "bad_input");
      made.setGovernor(r.id, input.settings === null ? null : input.settings);
      return { id: r.id, settings: settingsOf(new URL(JSON.parse(r.declaration).base_url).hostname, input.settings === null ? undefined : input.settings) };
    },
  });

  ctx.tool("connectors.site.resume", {
    effect: "write", callers: people,
    description: "Resume a website account after a challenge: { id }. The account was stopped at the first challenge the site gave (a check, a captcha, a security verification); a person clears it in the browser, then says so here. Nothing resumes by itself.",
    input: obj({ id: str }, ["id"]),
    run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
      yours(meta, "resume a stopped website account");
      const r = made.row(String(input.id));
      if (!r) throw fail(`no connection ${String(input.id).slice(0, 40)}`, "not_found");
      return { id: r.id, resumed: governor.resume(r.id) };
    },
  });

  ctx.tool("connectors.site.rollback", {
    effect: "write", callers: people,
    description: "Put one operation of a website Connection back to an earlier version it still holds: { id, name, version }. The Connection is brought up to date with it. Your own act.",
    input: obj({ id: str, name: str, version: { type: "integer" }, row: str }, []),
    run: async (/** @type {any} */ rawInput, /** @type {any} */ meta) => {
      const as = yours(meta, "roll back an operation");
      // a row of the Website operations view names the Connection and the operation ("linkedin:searchPeople") and means: back to the version before this one
      let input = rawInput;
      if (typeof rawInput.row === "string" && rawInput.row.includes(":")) {
        const [cid, ...rest] = rawInput.row.split(":");
        const name = rest.join(":");
        const row0 = made.row(cid);
        const d0 = row0 && JSON.parse(row0.declaration);
        const e0 = d0 && d0.transport === "site" ? (await recordOps(call, d0.base_url)).find(x => x.name === name) : null;
        const back = e0 && e0.prev && e0.prev[0] ? e0.prev[0].version : null;
        if (!back) throw fail("there is no earlier version of that operation to go back to", "not_found");
        input = { id: cid, name, version: back };
      }
      if (!input.id || !input.name || !Number.isInteger(input.version)) throw fail("rollback names { id, name, version } or a row of the Website operations view", "bad_input");
      const r = made.row(String(input.id));
      if (!r) throw fail(`no connection ${String(input.id).slice(0, 40)}`, "not_found");
      const d = JSON.parse(r.declaration);
      if (d.transport !== "site") throw fail(`${r.id} is not a website connection`, "bad_input");
      const rb = await call("memory.site.rollback", { origin: d.base_url, name: String(input.name), version: Number(input.version) });
      if (rb.error) throw fail(rb.error.message, rb.error.code || "failed");
      if (!rb.data || !rb.data.rolledBack) throw fail("that version is not held (see connectors.site.operations)", "not_found");
      const entries = pick(await recordOps(call, d.base_url), Object.values(d.ops).map((/** @type {any} */ o) => o.site && o.site.name).filter(Boolean));
      await made.saveSite({ id: r.id, label: r.label, origin: d.base_url, entries }, { as, replace: true });
      return { rolledBack: true, name: input.name, version: rb.data.version };
    },
  });

  ctx.tool("connectors.site.run", {
    effect: "write", internal: true, callers: ["module"],
    description: "Run one call to a website Connection in the browser that holds the login, for the vault: { credential, method, path, query?, body?, approved? } -> { status, data }. Never called directly.",
    input: obj({ credential: str, method: str, path: str, query: { type: "object" }, body: {}, approved: { type: "boolean" } }, ["credential", "method", "path"]),
    run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
      if (!meta || meta.caller !== "module:vault") throw fail("only the vault runs a website Connection's call", "denied");
      return runner.run(input);
    },
  });
  void readers;
}
