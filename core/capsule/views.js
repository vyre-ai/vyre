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
import { allowed, fill, fillDeep, dataOf, listFrame, detailFrame, formFrame, askedHash, effectOf, error, clip, actionsOf, LIMITS } from "./frames.js";

const PERSON = [...SURFACE_LABELS, "tailnet"];
/** How long the fields of the last list's rows are kept, for the templates of an action on one. */
const ROW_MS = 60_000;
/** Answers a tool gives when a credential or a connection is missing. */
const NEEDS = new Set(["needs", "needs_credential", "not_connected", "not_signed_in", "locked"]);

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
    const cap = m.state === "running" && m.shows && m.shows.capsule && typeof m.shows.capsule === "object" && !Array.isArray(m.shows.capsule) ? m.shows.capsule : null;
    if (!cap) continue;
    const firstParty = Boolean(m.firstParty);
    /** @type {any[]} */ const actions = [];
    for (const [key, v] of Object.entries(cap)) {
      if (!key.startsWith("action:") || !v || typeof v !== "object" || v.hide) continue;
      const [tool, suffix] = key.slice(7).split("#");
      actions.push({ id: commandId(tool + (suffix ? "-" + suffix : "")), title: String(v.title || tool), tool, input: v.input && typeof v.input === "object" ? v.input : {}, legacy: true });
    }
    for (const [key, v] of Object.entries(cap)) {
      if (key.startsWith("view:") && v && typeof v === "object") {
        const id = key.slice(5);
        out.set(`${m.name}/${id}`, { module: m.name, id, firstParty, decl: v, needsSlots: m.needsSlots || [], needsTools: m.needsTools || [] });
      } else if (key.startsWith("results:") && v && typeof v === "object") {
        const tool = key.slice(8), id = commandId(tool);
        // The short form: a search that answers { rows: [{ id, name, kind, sub }] }, and the actions declared beside it.
        out.set(`${m.name}/${id}`, { module: m.name, id, firstParty, needsSlots: [], needsTools: m.needsTools || [],
          decl: { title: String(v.title || tool), root: true, arg: { name: "q" }, list: { tool, input: { q: "{q}" }, map: { rows: "rows", id: "id", title: "name", subtitle: "sub", accessory: "kind" }, actions } } });
      }
    }
  }
  return out;
}

/** @param {any} decl */
const hashOf = decl => crypto.createHash("sha256").update(JSON.stringify(decl)).digest("hex").slice(0, 16);

/** The tool an action or view runs. @param {any} cmd */
function listOf(cmd) { return cmd.decl.list && typeof cmd.decl.list === "object" ? cmd.decl.list : null; }

/**
 * Register the view tools on the capsule module's ctx (local/capsule).
 * @param {any} ctx
 */
export function registerViews(ctx) {
  {
    /** The fields of the last list's rows, by module/command: kept a minute, in memory. @type {Map<string, { at: number, rows: Map<string, Record<string, string>> }>} */
    const rowCache = new Map();
    const rowsOf = (/** @type {string} */ key) => { const c = rowCache.get(key); return c && Date.now() - c.at < ROW_MS ? c.rows : new Map(); };

    const find = (/** @type {any} */ input) => {
      const cmd = commandsOf(ctx.modules.status()).get(`${input.module}/${input.command}`);
      if (!cmd) throw Object.assign(new Error(`no command ${input.module}/${input.command}`), { code: "not_found" });
      return cmd;
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
        if (NEEDS.has(code)) return { v: 1, kind: "needs", code, message: clip(e.message || "A connection is missing.", 200) };
        return error(code, e.message || "That did not work.");
      }
      const d = dataOf(r);
      if (d && typeof d === "object" && (d.state === "held" || d.held === true)) return { v: 1, kind: "held", ...(d.id ? { id: String(d.id) } : {}), message: "Waiting for your OK." };
      return null;
    };

    ctx.tool("capsule.commands", {
      callers: PERSON,
      description: "Every command the running modules declare for the Capsule, titles and keywords only: [{ module, id, title, keywords, alias, icon, root, arg, taggable, firstParty, hash }]. Sorted by title. An added module's commands carry firstParty false, and the Capsule marks its rows \"from <module>\"; its root is off until the person turns it on.",
      input: { type: "object", properties: {} },
      run: async () => ({
        commands: [...commandsOf(ctx.modules.status()).values()].map(c => ({
          module: c.module, id: c.id, title: clip(c.decl.title, 60), keywords: Array.isArray(c.decl.keywords) ? c.decl.keywords : [], ...(c.decl.alias ? { alias: c.decl.alias } : {}),
          ...(c.decl.icon ? { icon: c.decl.icon } : {}), root: c.firstParty && Boolean(c.decl.root), ...(c.decl.arg ? { arg: c.decl.arg } : {}),
          taggable: false, firstParty: c.firstParty, hash: hashOf(c.decl),
        })).sort((a, b) => a.title.localeCompare(b.title) || a.module.localeCompare(b.module)),
      }),
    });

    ctx.tool("capsule.view", {
      callers: PERSON,
      description: "One frame for a command: { v: 1, kind: \"list\" | \"detail\" | \"form\" | \"error\" | \"needs\" | \"held\", ... }. `view` is list (default), detail (with id) or form (with form). Rows carry action ids, never tool names; text is data.",
      input: { type: "object", required: ["module", "command"], properties: { module: { type: "string" }, command: { type: "string" }, view: { type: "string", enum: ["list", "detail", "form"] }, q: { type: "string", maxLength: 500 }, id: { type: "string", maxLength: 200 }, form: { type: "string" }, cursor: { type: "string" } } },
      run: async (input, meta) => {
        const cmd = find(input), key = `${cmd.module}/${cmd.id}`, decl = cmd.decl, list = listOf(cmd);
        const front = cmd.needsSlots.includes("front");
        const q = String(input.q || "");
        if (input.view === "form" || decl.form) {
          const name = String(input.form || decl.form || "");
          const form = decl.forms && decl.forms[name];
          if (!form) return error("not_found", "That form is gone.");
          return formFrame(form, { ...(rowsOf(key).get(String(input.id || "")) || { id: String(input.id || "") }), q }, name);
        }
        if (!list) return error("not_found", "That command has no list.");
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

    ctx.tool("capsule.act", {
      callers: PERSON,
      description: "What an action does: { v: 1, kind: \"done\" | \"held\" | \"needs\" | \"error\" | \"view\" | \"preview\" | \"push\", ... }. A `do` effect (open, copy, say, ask) is returned for the Capsule to carry out; a tool action calls the module's own tool. An outward action first answers a preview with the exact words and a hash; the same call with `asked: { hash }` sends. Nothing is sent until the person's second Enter.",
      input: { type: "object", required: ["module", "command", "action"], properties: { module: { type: "string" }, command: { type: "string" }, action: { type: "string" }, id: { type: "string", maxLength: 200 }, q: { type: "string", maxLength: 500 }, form: { type: "string" }, fields: { type: "object" }, front: { type: "object" }, asked: { type: "object" } } },
      run: async (input, meta) => {
        const cmd = find(input), key = `${cmd.module}/${cmd.id}`, decl = cmd.decl, list = listOf(cmd);
        const front = cmd.needsSlots.includes("front");
        const row = rowsOf(key).get(String(input.id || "")) || { id: String(input.id || "") };
        const fields = Object.fromEntries(Object.entries(input.fields && typeof input.fields === "object" ? input.fields : {}).slice(0, LIMITS.fields).map(([k, v]) => [k, clip(v, 8000)]));
        const vars = { ...row, q: String(input.q || ""), ...fields,
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
            if (kind === "push") return { v: 1, kind: "push", command: fill(a.do.push, vars, names) };
            const r = effectOf(a.do, vars, names, cmd.firstParty);
            return "error" in r ? r.error : { v: 1, kind: "done", effect: r.effect };
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
          if (!asked || asked.hash !== hash) {
            return { v: 1, kind: "preview", title: clip(title, 60), words: Object.entries(toolInput).slice(0, 12).map(([k, v]) => ({ label: clip(k, 40), value: clip(typeof v === "string" ? v : JSON.stringify(v), 2000) })), hash };
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
