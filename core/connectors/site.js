// @ts-check
// site: Connections to websites, signed in through a browser. The learned operations of a site (lib/siteops, kept in the one site record) become the operations of a Connection, so Flows,
// watchers, views and assistants call them like any other Connection's, a send is held at the Gate, and the Connection has a light. Where the call goes is the only difference: not over HTTP with
// a key but into a browser that is signed in. The login never reaches Vyre.
//
// How a call travels: a Flow step (or a view, or an assistant through connectors.operation.run) addresses the Connection's virtual route; the vault judges it as it judges every request (the
// route rules, its class, the Gate's hold and approval); then, instead of making an HTTP request, it hands the call to `connectors.site.run`, here, which picks the rung (the way to a browser
// that holds the login) and runs the operation there. Rung "page" is the person's own Chrome on this machine (chrome.op.run).

import { operationOf } from "../../records/connectors/site.js";

/** @typedef {import("../../records/connectors/format.js").Declaration} Declaration */

const STATUS_OF = /** @type {Record<string, number>} */ ({ input: 400, auth: 401, blocked: 403, rate: 429, drift: 502, error: 502, held: 409 });

/**
 * Said in plain words, per class, for the Connection's light.
 * @param {string} cls @param {string} host @param {string} [reason]
 */
export function lightFor(cls, host, reason) {
  switch (cls) {
    case "ok": return { light: "green", words: "connected" };
    case "auth": return { light: "red", words: `sign in to ${host} again in the browser Vyre uses` };
    case "blocked": return { light: "red", words: `${host} is challenging the browser: a person has to clear it once` };
    case "rate": return { light: "red", words: `${host} says to slow down` };
    case "drift": return { light: "red", words: `${host} changed and the operation could not be repaired: teach it again` };
    case "no_browser": return { light: "red", words: `no signed-in browser is connected: open Chrome with Vyre for Chrome${host ? ` and sign in to ${host}` : ""}` };
    default: return { light: "red", words: `the last call did not work${reason ? `: ${String(reason).slice(0, 120)}` : ""}` };
  }
}

/**
 * The runner: picks a rung and runs one operation there.
 * @param {{ call: (tool: string, input: any, opts?: any) => Promise<any>, made: any, emit?: (type: string, payload: any) => void, log?: (m: string, x?: any) => void }} deps
 */
export function createSiteRunner({ call, made, emit = () => {}, log = () => {} }) {
  /** One rung. Today: this machine's Chrome. @param {string} origin @param {string} name @param {Record<string, any>} inputs @param {boolean} approved @param {boolean} [check] */
  async function pageRung(origin, name, inputs, approved, check = false) {
    const r = await call("chrome.op.run", { site: origin, name, inputs, approved, ...(check ? { check: true } : {}) });
    if (r && r.error) {
      const code = String(r.error.code || "");
      if (/no_such_tool|no tool|unavailable|no_extension|no_tab|not connected/i.test(`${code} ${r.error.message}`)) return { class: "no_browser", reason: String(r.error.message || code) };
      return { class: "error", reason: String(r.error.message || code) };
    }
    return r.data;
  }

  /**
   * @param {{ credential: string, method: string, path: string, query?: any, body?: any, approved?: boolean }} q
   * @returns {Promise<{ status: number, data: any }>}
   */
  async function run(q) {
    const id = String(q.credential || "").replace(/^conn-/, "");
    const row = made.row(id);
    if (!row) return { status: 404, data: { error: { class: "input", reason: "no such Connection" } } };
    /** @type {Declaration} */ const decl = JSON.parse(row.declaration);
    if (decl.transport !== "site") return { status: 400, data: { error: { class: "input", reason: "not a website Connection" } } };
    const op = operationOf(decl, q);
    if (!op) return { status: 404, data: { error: { class: "input", reason: "that route is not one of the Connection's operations" } } };
    const host = new URL(/** @type {string} */ (decl.base_url)).hostname;
    const res = await pageRung(/** @type {string} */ (decl.base_url), op.name, op.inputs, q.approved === true);
    const cls = res && res.ok ? "ok" : String((res && res.class) || "error");
    if (cls !== "held") {
      const l = lightFor(cls, host, res && res.reason);
      made.touch(id, l.light, l.words);
      emit("connectors.connection-checked", { id, light: l.light });
      if (cls === "auth") emit("connectors.site-needs-signin", { id, site: decl.base_url, host });
    }
    if (cls === "ok") return { status: 200, data: res.data === undefined ? null : res.data };
    log("site operation did not answer", { id, op: op.name, class: cls });
    const status = cls === "no_browser" ? 503 : STATUS_OF[cls] || 502;
    return { status, data: { error: { class: cls, reason: res && res.reason ? String(res.reason) : cls, ...(res && res.next ? { next: String(res.next) } : {}) } } };
  }

  /** Can the browser sign for this Connection right now (the right site is open, the references resolve)? @param {string} id */
  async function check(id) {
    const row = made.row(id);
    if (!row) throw Object.assign(new Error(`no connection ${id}`), { code: "not_found" });
    /** @type {Declaration} */ const decl = JSON.parse(row.declaration);
    const host = new URL(/** @type {string} */ (decl.base_url)).hostname;
    const first = Object.values(decl.ops).find(o => o.site);
    if (!first || !first.site) return { light: "red", words: "no operations are kept for this site yet" };
    const res = await pageRung(/** @type {string} */ (decl.base_url), first.site.name, {}, false, true);
    if (res && res.class === "no_browser") return lightFor("no_browser", host);
    if (res && res.onSite === false) return { light: "red", words: `open ${host} in Chrome first` };
    return res && res.ok ? { light: "green", words: "signed in and ready" } : lightFor("auth", host);
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
 * The tools of a site Connection. Connecting and syncing widen what a Connection reaches, so they are the person's own acts; the list is open to readers; `run` is the vault's alone.
 * @param {any} ctx @param {{ made: any, runner: ReturnType<typeof createSiteRunner>, yours: (meta: any, what: string) => string, fail: (m: string, c?: string) => Error, obj: Function, str: any, people: string[], readers: string[] }} d
 */
export function registerSiteTools(ctx, { made, runner, yours, fail, obj, str, people, readers }) {
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
    input: obj({ site: str, label: str, id: str, operations: { type: "array", items: str }, polls: { type: "array", description: "Reads a watcher may poll: [{ name, operation, id (path of an item's own id), items?, title?, at?, args?, every_minutes? }]." } }, ["site", "label"]),
    run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
      const as = yours(meta, "connect a website");
      const origin = originOf(input.site);
      const entries = pick(await recordOps(call, origin), input.operations);
      return made.saveSite({ id: input.id, label: String(input.label), origin, entries, ...(Array.isArray(input.polls) ? { polls: input.polls } : {}) }, { as });
    },
  });

  ctx.tool("connectors.site.sync", {
    effect: "write", callers: people,
    description: "Bring a website Connection up to date with what Vyre has learned on the site: { id, operations? }. New or repaired operations appear; the shapes a Flow is checked against change with them. Your own act.",
    input: obj({ id: str, operations: { type: "array", items: str } }, ["id"]),
    run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
      const as = yours(meta, "change a website connection");
      const r = made.row(String(input.id));
      if (!r) throw fail(`no connection ${String(input.id).slice(0, 40)}`, "not_found");
      const d = JSON.parse(r.declaration);
      if (d.transport !== "site") throw fail(`${r.id} is not a website connection`, "bad_input");
      const entries = pick(await recordOps(call, d.base_url), Array.isArray(input.operations) ? input.operations : Object.values(d.ops).map((/** @type {any} */ o) => o.site && o.site.name).filter(Boolean));
      return made.saveSite({ id: r.id, label: r.label, origin: d.base_url, entries }, { as, replace: true });
    },
  });

  ctx.tool("connectors.site.operations", {
    effect: "read", callers: [...people, "module", "mcp", "harness"],
    description: "The operations of a website Connection with their versions and health: { id } -> { site, light, reason, operations: [{ name, kind, inputs, version, health, history: [{ version, replacedAt }] }] }. What the Connection page shows; rollback and the sign-in card hang off it.",
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

  ctx.tool("connectors.site.rollback", {
    effect: "write", callers: people,
    description: "Put one operation of a website Connection back to an earlier version it still holds: { id, name, version }. The Connection is brought up to date with it. Your own act.",
    input: obj({ id: str, name: str, version: { type: "integer" } }, ["id", "name", "version"]),
    run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
      const as = yours(meta, "roll back an operation");
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
