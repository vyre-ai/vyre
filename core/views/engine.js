// @ts-check
// capsule views: what the Capsule lists and does, from the manifests (ADR 0033, capsule-vs-raycast Part 2).
//
// A module declares `view:<id>` entries in shows.capsule (a list, a detail and a form, and the
// actions on a row). This module reads them and answers three questions for the Capsule: what
// commands exist (`capsule.commands`), what one shows (`capsule.view`), and what an action does
// (`capsule.act`). The Capsule sends ids and never tool names; vyred looks the declaration up,
// fills its templates from a fixed set, calls the module's own tool and returns one small frame.
// A first party module's tools run as the person's surface, as today; an added module's run as
// module:<name>, never as the person, and every row it draws is marked as its own.
// The older `results:<tool>` and `action:<tool>` keys are the same thing written short.

import crypto from "node:crypto";
import { SURFACE_LABELS } from "../modules/index.js";
import { withOperations, allowed, fill, fillDeep, dataOf, listFrame, boardFrame, summaryFrame, detailFrame, formFrame, askedHash, previewToken, previewOk, effectOf, error, clip, actionsOf, LIMITS } from "./frames.js";

const PERSON = [...SURFACE_LABELS, "tailnet", "device", "space", "agent"];
/** How long the fields of the last list's rows are kept, for the templates of an action on one. */
const ROW_MS = 60_000;
/** Answers a tool gives when a credential or a connection is missing. */
const NEEDS = new Set(["needs", "needs_credential", "not_connected", "not_signed_in", "locked"]);

/**
 * The `need` of a needs frame, so Lumen can open "Add your key" directly: a tool that lacks a credential throws
 * needs_credential with detail { module, need, account? } (core/modules/needs-credential.js), or names a vault item.
 * { kind: "credential", need | item, module?, label? }; nothing when the detail says neither.
 * @param {any} detail
 */
export function needOf(detail) {
  if (!detail || typeof detail !== "object") return {};
  const str = (/** @type {any} */ v, /** @type {number} */ n) => (typeof v === "string" && v ? v.slice(0, n) : "");
  const need = str(detail.need, 80), item = str(detail.item, 120);
  if (!need && !item) return {};
  const module = str(detail.module, 60), label = str(detail.label || detail.vendor, 60);
  return { need: { kind: "credential", ...(need ? { need } : { item }), ...(module ? { module } : {}), ...(label ? { label } : {}) } };
}

/** @param {string} tool */
const commandId = tool => tool.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Every command the running modules declare, the older keys folded in.
 * @param {any[]} status rows from ctx.modules.status()
 * @returns {Map<string, any>} "<module>/<id>" -> the command
 */
export function commandsOf(status) {
  /** @type {Map<string, any>} */
  const out = new Map();
  for (const m of status) {
    if (m.state !== "running") continue;
    const cap = m.shows && m.shows.capsule && typeof m.shows.capsule === "object" && !Array.isArray(m.shows.capsule) ? m.shows.capsule : {};
    const own = m.views && typeof m.views === "object" && !Array.isArray(m.views) ? m.views : {};
    if (!Object.keys(cap).length && !Object.keys(own).length) continue;
    const firstParty = Boolean(m.firstParty);
    /** @type {any[]} */ const actions = [];
    for (const [key, v] of Object.entries(cap)) {
      if (!key.startsWith("action:") || !v || typeof v !== "object" || v.hide) continue;
      const [tool, suffix] = key.slice(7).split("#");
      actions.push({ id: commandId(tool + (suffix ? "-" + suffix : "")), title: String(v.title || tool), tool, input: v.input && typeof v.input === "object" ? v.input : {}, legacy: true });
    }
    // One declaration serves the app and the Capsule: `views` is the key, shows.capsule's `view:<id>` entries are the same thing under the older name, and `views` wins when both name an id.
    for (const [key, v] of Object.entries(cap)) {
      if (key.startsWith("view:") && v && typeof v === "object") {
        const id = key.slice(5);
        out.set(`${m.name}/${id}`, { module: m.name, id, firstParty, decl: withOperations(v), needsSlots: m.needsSlots || [], needsTools: m.needsTools || [] });
      } else if (key.startsWith("results:") && v && typeof v === "object") {
        const tool = key.slice(8), id = commandId(tool);
        // The short form: a search that answers { rows: [{ id, name, kind, sub }] }, and the actions declared beside it.
        out.set(`${m.name}/${id}`, { module: m.name, id, firstParty, needsSlots: [], needsTools: m.needsTools || [],
          decl: { title: String(v.title || tool), root: true, arg: { name: "q" }, list: { tool, input: { q: "{q}" }, map: { rows: "rows", id: "id", title: "name", subtitle: "sub", accessory: "kind" }, actions } } });
      }
    }
    for (const [id, v] of Object.entries(own)) {
      if (v && typeof v === "object") out.set(`${m.name}/${id}`, { module: m.name, id, firstParty, decl: withOperations(v), needsSlots: m.needsSlots || [], needsTools: m.needsTools || [] });
    }
  }
  return out;
}

/** @param {any} decl */
const hashOf = decl => crypto.createHash("sha256").update(JSON.stringify(decl)).digest("hex").slice(0, 16);

/** The part of a view that reads a tool and carries the row actions: its list, else its board, else its summary. @param {any} cmd */
function listOf(cmd) { const d = cmd.decl; return d.list && typeof d.list === "object" ? d.list : d.board && typeof d.board === "object" ? d.board : d.summary && typeof d.summary === "object" ? d.summary : null; }

/** What a view first shows: list, board, summary or form. @param {any} decl */
export function kindOf(decl) { return decl.list ? "list" : decl.board ? "board" : decl.summary ? "summary" : decl.form || decl.forms ? "form" : "list"; }

/** The MCP hub's tools as a Capsule command per server (Part 2, step 11): a list of the server's tools and a form built from a tool's input schema. */
/** @param {any} name */
const serverId = name => `server-${name}`;

/** A form's fields from a JSON Schema's top-level properties: text, number, bool, choice, or JSON in a multiline box. @param {any} schema */
export function fieldsFromSchema(schema) {
  const props = schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = new Set(Array.isArray(schema && schema.required) ? schema.required : []);
  return Object.entries(props).slice(0, LIMITS.fields).map(([name, p0]) => {
    const p = /** @type {any} */ (p0) || {};
    const type = Array.isArray(p.enum) && p.enum.length && p.enum.length <= 30 ? "choice" : p.type === "integer" || p.type === "number" ? "number" : p.type === "boolean" ? "bool" : p.type === "array" || p.type === "object" ? "multiline" : "text";
    return { name: name.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 30), source: name, label: clip(p.title || name, 60) + (p.type === "array" || p.type === "object" ? " (JSON)" : ""), type, ...(required.has(name) ? { required: true } : {}), ...(type === "choice" ? { choices: p.enum.map(String) } : {}), json: p.type === "array" || p.type === "object", numeric: p.type };
  });
}

/** Form values back into the tool's arguments. @param {any[]} defs @param {Record<string, any>} values */
function argsFromFields(defs, values) {
  /** @type {Record<string, any>} */ const out = {};
  for (const d of defs) {
    const v = values[d.name];
    if (v === undefined || v === "") continue;
    if (d.type === "number") { const n = Number(v); if (!Number.isFinite(n)) return { error: `${d.label} must be a number.` }; out[d.source] = d.numeric === "integer" ? Math.trunc(n) : n; }
    else if (d.type === "bool") out[d.source] = v === true || v === "true" || v === "1" || v === "yes";
    else if (d.json) { try { out[d.source] = JSON.parse(String(v)); } catch { return { error: `${d.label} is not valid JSON.` }; } }
    else out[d.source] = String(v);
  }
  return { args: out };
}

/** The text of an MCP tool's answer. @param {any} d */
function textOf(d) {
  if (d && Array.isArray(d.content)) return d.content.map((/** @type {any} */ c) => (c && typeof c.text === "string" ? c.text : "")).filter(Boolean).join("\n");
  if (typeof d === "string") return d;
  try { return JSON.stringify(d, null, 2); } catch { return ""; }
}

/**
 * Register the view tools: on the capsule module's ctx (local/capsule) as capsule.commands, capsule.view and capsule.act, and on the views module's ctx (core/views) as views.list, views.get and views.act.
 * @param {any} ctx @param {{ names?: { commands: string, view: string, act: string }, surface?: "app" | "capsule", mcp?: boolean }} [opts]
 */
export function registerViews(ctx, opts = {}) {
  const names = { commands: "capsule.commands", view: "capsule.view", act: "capsule.act", ...(opts.names || {}) };
  /** The Capsule draws list, detail and form; the app draws board and summary too. */
  const surface = opts.surface === "app" ? "app" : "capsule";
  const hubServers = opts.mcp !== false;
  {
    /** The fields of the last list's rows, by module/command: kept a minute, in memory. @type {Map<string, { at: number, rows: Map<string, Record<string, string>> }>} */
    const rowCache = new Map();
    const rowsOf = (/** @type {string} */ key) => { const c = rowCache.get(key); return c && Date.now() - c.at < ROW_MS ? c.rows : new Map(); };

    /** The declared commands, and a "tools" command for each MCP hub server the person may use. */
    const allCommands = async (/** @type {string} */ caller) => {
      const out = commandsOf(ctx.modules.status());
      if (surface === "capsule") for (const [k, c] of out) if (!c.decl.list && !c.decl.form && !c.decl.forms) out.delete(k); // the Capsule has no board or summary to draw
      if (hubServers && ctx.modules.status().some((/** @type {any} */ m) => m.name === "mcp" && m.state === "running")) {
        try {
          const r = await ctx.call("mcp.servers", {}, { as: caller });
          for (const sv of (Array.isArray(dataOf(r)) ? dataOf(r) : (dataOf(r) && dataOf(r).servers) || [])) {
            if (!sv || typeof sv.name !== "string") continue;
            out.set(`mcp/${serverId(sv.name)}`, { module: "mcp", id: serverId(sv.name), firstParty: true, server: sv.name, needsSlots: [], needsTools: [],
              decl: { title: `${clip(sv.name, 40)} tools`, keywords: [sv.name, "mcp", "tools"], icon: "wrench", arg: { name: "q", placeholder: "tool" } } });
          }
        } catch { /* no hub, no server commands */ }
      }
      return out;
    };
    const find = async (/** @type {any} */ input, /** @type {string} */ caller) => {
      const cmd = (await allCommands(caller)).get(`${input.module}/${input.command}`);
      if (!cmd) throw Object.assign(new Error(`no command ${input.module}/${input.command}`), { code: "not_found" });
      return cmd;
    };

    /** A hub server's tools, filtered by the typed words, as one list frame. @param {any} cmd @param {string} q @param {string} caller */
    const serverList = async (cmd, q, caller) => {
      const r = await run(cmd, "mcp.tools", {}, caller, null);
      const bad = problem(r);
      if (bad) return bad;
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const tools = (Array.isArray(dataOf(r)) ? dataOf(r) : []).filter((/** @type {any} */ t) => t && t.server === cmd.server
        && words.every(w => `${t.tool} ${t.description || ""}`.toLowerCase().includes(w)));
      const rows = tools.slice(0, LIMITS.rows).map((/** @type {any} */ t) => ({ id: clip(t.tool, 200), title: clip(t.tool, 120), ...(t.description ? { subtitle: clip(t.description, 200) } : {}), accessory: t.outward ? "held" : "read",
        actions: [{ id: "run", title: t.outward ? "Fill in and send" : "Run", outward: Boolean(t.outward) }] }));
      return { v: 1, kind: "list", title: clip(cmd.decl.title, 60), rows, ...(tools.length > LIMITS.rows ? { more: true } : {}), ...(rows.length ? {} : { empty: "No tool matches that." }) };
    };
    /** @param {any} cmd @param {string} tool @param {string} caller */
    const serverTool = async (cmd, tool, caller) => {
      const r = await run(cmd, "mcp.tools", {}, caller, null);
      return (Array.isArray(dataOf(r)) ? dataOf(r) : []).find((/** @type {any} */ t) => t && t.server === cmd.server && t.tool === tool) || null;
    };

    /**
     * Call a declared tool: a first party module's as the asking person's surface, an added
     * module's as itself, never as the person. The registry refuses any tool the module did not
     * declare in this view (Registry.capsuleMayCall).
     */
    const run = async (/** @type {any} */ cmd, /** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller, /** @type {any} */ asked) => {
      const as = cmd.firstParty ? caller : `module:${cmd.module}`;
      try { return await ctx.call(tool, input, { as, ...(asked ? { asked } : {}) }); }
      catch (e) { return { error: { code: /** @type {any} */ (e).code || "failed", message: /** @type {Error} */ (e).message } }; }
    };

    /** A tool's failure or hold as the frame the Capsule knows. @param {any} r */
    const problem = r => {
      const e = r && (r.error || (r.data && r.data.error));
      if (e) {
        const code = String(e.code || "failed");
        if (code === "held" || code === "held_unavailable") return { v: 1, kind: "held", message: clip(e.message || "Waiting for your OK.", 200) };
        if (NEEDS.has(code)) return { v: 1, kind: "needs", code, message: clip(e.message || "A connection is missing.", 200), ...needOf(e.detail) };
        return error(code, e.message || "That did not work.");
      }
      const d = dataOf(r);
      if (d && typeof d === "object" && (d.state === "held" || d.held === true)) return { v: 1, kind: "held", ...(d.id ? { id: String(d.id) } : {}), message: "Waiting for your OK." };
      return null;
    };

    /** An action on a hub server's tool: open its form, or run it (an outward tool previews first, then the hub holds it at the Gate). */
    const serverAct = async (/** @type {any} */ cmd, /** @type {any} */ input, /** @type {string} */ caller) => {
      const tool = String(input.id || (input.form && String(input.form).startsWith("tool:") ? String(input.form).slice(5) : ""));
      const t = await serverTool(cmd, tool, caller);
      if (!t) return error("not_found", "That tool is gone.");
      const defs = fieldsFromSchema(t.input);
      if (input.action === "run") return { v: 1, kind: "view", frame: { v: 1, kind: "form", id: `tool:${t.tool}`, title: clip(t.tool, 100), fields: defs.map(({ name, label, type, required, choices }) => ({ name, label, type, ...(required ? { required } : {}), ...(choices ? { choices } : {}) })), submit: { title: t.outward ? "Send" : "Run", ...(t.outward ? { outward: true } : {}) } } };
      if (input.action !== "submit") return error("not_found", "That action is gone.");
      const values = input.fields && typeof input.fields === "object" ? input.fields : {};
      for (const d of defs) if (d.required && !String(values[d.name] ?? "").trim()) return error("missing", `${d.label} is needed.`);
      const parsed = argsFromFields(defs, values);
      if ("error" in parsed) return error("bad_input", String(parsed.error));
      if (t.outward) {
        const hash = askedHash("mcp", `${cmd.server}__${t.tool}`, parsed.args);
        const asked = input.asked && typeof input.asked === "object" ? input.asked : null;
        if (!asked || asked.hash !== hash || !previewOk(hash, caller, asked.token)) return { v: 1, kind: "preview", title: clip(`${cmd.server}: ${t.tool}`, 60), words: Object.entries(parsed.args).slice(0, 12).map(([k, v]) => ({ label: clip(k, 40), value: clip(typeof v === "string" ? v : JSON.stringify(v), 2000) })), hash, token: previewToken(hash, caller) };
      }
      const r = await run(cmd, "mcp.call", { server: cmd.server, tool: t.tool, arguments: parsed.args }, caller, null);
      const bad = problem(r);
      if (bad) return bad;
      const text = textOf(dataOf(r));
      return text.length > 300 || text.includes("\n") ? { v: 1, kind: "view", frame: { v: 1, kind: "detail", title: clip(`${cmd.server}: ${t.tool}`, 120), body: clip(text, LIMITS.body), fields: [], actions: [] } } : { v: 1, kind: "done", said: clip(text || "Done.", 300) };
    };

    ctx.tool(names.commands, {
      effect: "read",
      callers: PERSON,
      description: "Every command the running modules declare for the Capsule, titles and keywords only: [{ module, id, title, keywords, alias, icon, root, arg, taggable, firstParty, hash }]. Sorted by title. An added module's commands carry firstParty false, and the Capsule marks its rows \"from <module>\"; its root is off until the person turns it on.",
      input: { type: "object", properties: {} },
      run: async (_input, meta) => ({
        commands: [...(await allCommands(String(meta.caller))).values()].map(c => ({
          module: c.module, id: c.id, title: clip(c.decl.title, 60), keywords: Array.isArray(c.decl.keywords) ? c.decl.keywords : [], ...(c.decl.alias ? { alias: c.decl.alias } : {}),
          ...(c.decl.icon ? { icon: c.decl.icon } : {}), root: c.firstParty && Boolean(c.decl.root), ...(c.decl.arg ? { arg: c.decl.arg } : {}),
          taggable: false, kind: kindOf(c.decl), firstParty: c.firstParty, hash: hashOf({ ...c.decl, server: c.server }),
        })).sort((a, b) => a.title.localeCompare(b.title) || a.module.localeCompare(b.module)),
      }),
    });

    ctx.tool(names.view, {
      effect: "read",
      callers: PERSON,
      description: "One frame for a command: { v: 1, kind: \"list\" | \"board\" | \"summary\" | \"detail\" | \"form\" | \"error\" | \"needs\" | \"held\", ... }. `view` is list (default), detail (with id) or form (with form). Rows carry action ids, never tool names; text is data.",
      input: { type: "object", required: ["module", "command"], properties: { module: { type: "string" }, command: { type: "string" }, view: { type: "string", enum: ["list", "detail", "form", "board", "summary"] }, q: { type: "string", maxLength: 500 }, id: { type: "string", maxLength: 200 }, form: { type: "string" }, cursor: { type: "string" } } },
      run: async (input, meta) => {
        const cmd = await find(input, String(meta.caller)), key = `${cmd.module}/${cmd.id}`, decl = cmd.decl, list = listOf(cmd);
        const front = cmd.needsSlots.includes("front");
        const q = String(input.q || "");
        if (cmd.server) {
          if (input.view === "form") {
            const t = await serverTool(cmd, String(input.id || ""), String(meta.caller));
            if (!t) return error("not_found", "That tool is gone.");
            return { v: 1, kind: "form", id: `tool:${t.tool}`, title: clip(t.tool, 100), fields: fieldsFromSchema(t.input).map(({ name, label, type, required, choices }) => ({ name, label, type, ...(required ? { required } : {}), ...(choices ? { choices } : {}) })), submit: { title: t.outward ? "Send" : "Run", ...(t.outward ? { outward: true } : {}) } };
          }
          return serverList(cmd, q, String(meta.caller));
        }
        if (input.view === "form" || decl.form) {
          const name = String(input.form || decl.form || "");
          const form = decl.forms && decl.forms[name];
          if (!form) return error("not_found", "That form is gone.");
          return formFrame(form, { ...(rowsOf(key).get(String(input.id || "")) || { id: String(input.id || "") }), q }, name);
        }
        if (!list) return error("not_found", "That command has no list.");
        if (input.view !== "detail" && (decl.board || decl.summary) && !decl.list) {
          const part = decl.board ? decl.board : decl.summary;
          const r = await run(cmd, part.tool, fillDeep(part.input || {}, { q }, allowed({ front })), String(meta.caller));
          const bad = problem(r);
          if (bad) return bad;
          if (decl.board) {
            const { frame, rows } = boardFrame(decl.board, dataOf(r), { title: decl.title });
            rowCache.set(key, { at: Date.now(), rows });
            return { ...frame, ...(cmd.firstParty ? {} : { from: cmd.module }) };
          }
          return { ...summaryFrame(decl.summary, dataOf(r), { title: decl.title }), ...(cmd.firstParty ? {} : { from: cmd.module }) };
        }
        if (input.view === "detail") {
          if (!list.detail) return error("not_found", "That row has no detail.");
          const row = rowsOf(key).get(String(input.id || "")) || { id: String(input.id || "") };
          const vars = { ...row, q };
          const r = await run(cmd, list.detail.tool, fillDeep(list.detail.input || { id: "{id}" }, vars, allowed({ front })), String(meta.caller));
          return problem(r) || detailFrame(list.detail, dataOf(r), { title: row.title || decl.title, actions: list.actions });
        }
        const r = await run(cmd, list.tool, fillDeep(list.input || {}, { q }, allowed({ front })), String(meta.caller));
        const bad = problem(r);
        if (bad) return bad;
        const { frame, rows } = listFrame(list, dataOf(r), { title: decl.title });
        rowCache.set(key, { at: Date.now(), rows });
        return { ...frame, ...(cmd.firstParty ? {} : { from: cmd.module }) };
      },
    });

    ctx.tool(names.act, {
      effect: "write",
      callers: PERSON,
      description: "What an action does: { v: 1, kind: \"done\" | \"held\" | \"needs\" | \"error\" | \"view\" | \"preview\" | \"push\", ... }. A `do` effect (open, copy, say, ask) is returned for the Capsule to carry out; a tool action calls the module's own tool. An outward action first answers a preview with the exact words and a hash; the same call with `asked: { hash }` sends. Nothing is sent until the person's second Enter.",
      input: { type: "object", required: ["module", "command", "action"], properties: { module: { type: "string" }, command: { type: "string" }, action: { type: "string" }, column: { type: "string", maxLength: 40 }, id: { type: "string", maxLength: 200 }, q: { type: "string", maxLength: 500 }, form: { type: "string" }, fields: { type: "object" }, front: { type: "object" }, asked: { type: "object" } } },
      run: async (input, meta) => {
        const cmd = await find(input, String(meta.caller)), key = `${cmd.module}/${cmd.id}`, decl = cmd.decl, list = listOf(cmd);
        const front = cmd.needsSlots.includes("front");
        if (cmd.server) return serverAct(cmd, input, String(meta.caller));
        const row = rowsOf(key).get(String(input.id || "")) || { id: String(input.id || "") };
        const fields = Object.fromEntries(Object.entries(input.fields && typeof input.fields === "object" ? input.fields : {}).slice(0, LIMITS.fields).map(([k, v]) => [k, clip(v, 8000)]));
        const column = decl.board && Array.isArray(decl.board.columns) ? decl.board.columns.map((/** @type {any} */ c) => (typeof c === "string" ? c : c && c.id)).find((/** @type {any} */ c) => c === input.column) : undefined;
        const vars = { ...row, q: String(input.q || ""), ...(column ? { column } : {}), ...fields,
          ...(front && input.front && typeof input.front === "object" ? { "front.app": clip(input.front.app, 200), "front.selection": clip(input.front.selection, 4000) } : {}) };
        const names = allowed({ fields: Object.keys(fields), front });
        /** What to call, from an action or a form's submit. */
        let tool = "", inputTpl = {}, outward = false, title = "", id = "";
        if (input.action === "submit") {
          const form = decl.forms && decl.forms[String(input.form || decl.form || "")];
          if (!form) return error("not_found", "That form is gone.");
          ({ tool, inputTpl, outward, title } = { tool: form.submit.tool, inputTpl: form.submit.input || {}, outward: Boolean(form.submit.outward), title: form.submit.title });
          id = "submit";
          for (const f of form.fields) if (f.required && !String(fields[f.name] || "").trim()) return error("missing", `${f.label} is needed.`);
        } else {
          const a = (list && Array.isArray(list.actions) ? list.actions : []).find((/** @type {any} */ x) => x.id === input.action);
          if (!a) return error("not_found", "That action is gone.");
          if (a.do) {
            const kind = Object.keys(a.do)[0];
            if (kind === "push") {
              // A module goes only to its own commands, first party or not.
              const target = fill(a.do.push, vars, names);
              return (await allCommands(String(meta.caller))).has(`${cmd.module}/${target}`) ? { v: 1, kind: "push", command: target } : error("not_found", "That command is not this module's.");
            }
            const r = effectOf(a.do, vars, names, cmd.firstParty);
            // ask only prefills the box: the Capsule never sends it and never records it as the person's words; text from a module or a row is a stranger's until the person edits it.
            return "error" in r ? r.error : { v: 1, kind: "done", effect: r.effect, ...(kind === "ask" ? { prefill: true } : {}), ...(cmd.firstParty ? {} : { from: cmd.module }) };
          }
          if (a.form) {
            const form = decl.forms && decl.forms[a.form];
            return form ? { v: 1, kind: "view", frame: formFrame(form, vars, a.form) } : error("not_found", "That form is gone.");
          }
          ({ tool, inputTpl, outward, title, id } = { tool: a.tool, inputTpl: a.input || {}, outward: Boolean(a.outward), title: a.title, id: a.id });
          if (a.legacy && inputTpl && input.id) inputTpl = { ...inputTpl, id: String(input.id) };
        }
        const toolInput = fillDeep(inputTpl, vars, names) || {};
        // A send the person has not yet seen in full words is never sent from a declaration: an outward
        // action always previews, and the hash binds the second Enter to these exact words.
        if (outward) {
          const hash = askedHash(cmd.module, tool, toolInput);
          const asked = input.asked && typeof input.asked === "object" ? input.asked : null;
          if (!asked || asked.hash !== hash || !previewOk(hash, String(meta.caller), asked.token)) {
            return { v: 1, kind: "preview", title: clip(title, 60), words: Object.entries(toolInput).slice(0, 12).map(([k, v]) => ({ label: clip(k, 40), value: clip(typeof v === "string" ? v : JSON.stringify(v), 2000) })), hash, token: previewToken(hash, String(meta.caller)) };
          }
          const r = await run(cmd, tool, toolInput, String(meta.caller), { surface: String(meta.caller), hash, at: Date.now() });
          return problem(r) || { v: 1, kind: "done", said: clip((dataOf(r) && (dataOf(r).said || dataOf(r).message)) || `${clip(title, 40)} done.`, 300) };
        }
        const r = await run(cmd, tool, toolInput, String(meta.caller), null);
        return problem(r) || { v: 1, kind: "done", said: clip((dataOf(r) && (dataOf(r).said || dataOf(r).message)) || `${clip(title, 40)} done.`, 300) };
      },
    });
  }
}
