// @ts-check
// templates: the field names an app's item usually holds, for the Vault's Add sheet when Vyre itself declares nothing for that app (needs.credentials and the provider catalog
// come first, on the screen). The person types the app's name; the person's own AI account suggests the fields (names in env style, plain or secret, one line on where to find
// each); the person edits or accepts and fills the values on the screen. The suggestion is kept as this Space's template, so the next person adding the same app gets it at once.
//
// What leaves: the app's name, and nothing else, to the model. Never a value: values are typed after, on the person's own screen, and never reach this file. A name that looks
// like a key is refused before anything is asked. The model's answer is read as data (names, a yes or no, a short line), never run.
// Whose account: the owner's. The vault's member gate refuses these tools to anyone else (core/vault/member-gate.js), and threads.quick runs on the home's own account, which is
// the owner's own; a member's own-account path is not here yet, so a member adds fields by hand.
// Where: one JSON file beside the vault's database (templates.json). It holds field names and help lines only: operational state the screen rebuilds from, never a value.

import fs from "node:fs";
import path from "node:path";
import { canonical } from "../../../lib/env-name.js";
import { isConnectOwn } from "../../../lib/own-account.js";
import { classify } from "../../../lib/credential-shapes.js";
import { isAsker } from "../asker.js";

const PEOPLE = ["cli", "local", "deck", "capsule"];
const str = { type: "string" };
const obj = (/** @type {any} */ properties, /** @type {string[]} */ required = []) => ({ type: "object", properties, required });
const bad = (/** @type {string} */ m, code = "bad_input") => Object.assign(new Error(m), { code });

/** How many templates a Space keeps, and fields per template. */
const MAX_TEMPLATES = 300, MAX_FIELDS = 16;

/** The fixed words the model is given: what to answer and in what shape. The app's name is the only other thing it sees. */
export const SYSTEM = [
  "You list the settings a developer copies from a web app's dashboard to call its API: keys, tokens, ids, account numbers, URLs.",
  "Answer with JSON only, no prose: {\"fields\":[{\"name\":\"APP_API_KEY\",\"secret\":true,\"help\":\"Where to find it, in one short line.\"}]}.",
  "Names are environment variable names in UPPER_SNAKE case, starting with the app's short name. secret is false for ids, account numbers, URLs and public values; true for keys, tokens and passwords.",
  "List at most 6 fields, the ones most people need. If you do not know the app, answer {\"fields\":[]}.",
].join(" ");

/** @typedef {{ name: string, secret: boolean, help: string }} TField */
/** @typedef {{ app: string, fields: TField[], at: number }} Template */

/** The key one app is kept under: its name, lower case, words only. @param {string} app */
export const appKey = app => String(app || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * An app's name as the person typed it, checked before anything is asked: a short name of words, never something that looks like a key or a token.
 * @param {unknown} app @returns {string}
 */
export function appName(app) {
  const a = String(app ?? "").replace(/\s+/g, " ").trim();
  if (!a || a.length > 60 || !/^[\p{L}\p{N} .&+'()-]+$/u.test(a)) throw bad("Type the app's name, like the one on its website, in 60 letters or fewer.");
  if (/[A-Za-z0-9_-]{24,}/.test(a) || classify("", a).provider) throw bad("That looks like a key, not an app's name. Type the app's name; you fill its values in after.");
  return a;
}

/** A model's or a person's field list made safe to keep: canonical names, once each, a yes or no, a short printable line. @param {unknown} list @returns {TField[]} */
export function cleanFields(list) {
  /** @type {TField[]} */ const out = [];
  for (const f of Array.isArray(list) ? list.slice(0, MAX_FIELDS * 2) : []) {
    if (!f || typeof f !== "object") continue;
    const name = canonical(/** @type {any} */ (f).name);
    if (!name || out.some(x => x.name === name)) continue;
    const help = String(/** @type {any} */ (f).help ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
    out.push({ name, secret: /** @type {any} */ (f).secret !== false, help });
    if (out.length >= MAX_FIELDS) break;
  }
  return out;
}

/** The first JSON object in a model's answer, or null. @param {string} text */
const firstJson = text => {
  const s = String(text || ""), i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch { return null; }
};

/**
 * The store and the suggestion, apart from the registry, so a test drives them with a folder and a fake call.
 * @param {{ dir: string, call: (tool: string, input: any) => Promise<any>, now?: () => number }} o
 */
export function makeTemplates({ dir, call, now = Date.now }) {
  const file = path.join(dir, "templates.json");
  /** @returns {Record<string, Template>} */
  const read = () => {
    try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return j && typeof j.apps === "object" && j.apps ? j.apps : {}; } catch { return {}; }
  };
  /** @param {Record<string, Template>} apps */
  const write = apps => {
    const keep = Object.entries(apps).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_TEMPLATES);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, apps: Object.fromEntries(keep) }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  return {
    /** Every template this Space keeps: app name and fields, newest first. */
    list: () => Object.values(read()).sort((a, b) => b.at - a.at),
    /**
     * The fields for one app: this Space's template when there is one (no model call), else the person's own AI account's suggestion, kept as the template. No account, or no
     * answer, gives no fields and a reason the screen words (it then offers a blank item).
     * @param {string} app0 @returns {Promise<{ app: string, fields: TField[], source: "space" | "ai" | "none", why?: "no_account" | "no_answer" }>}
     */
    async suggest(app0) {
      const app = appName(app0);
      const key = appKey(app);
      const have = read()[key];
      if (have && have.fields.length) return { app: have.app, fields: have.fields, source: "space" };
      // the one model call: the fixed system words and the app's name, nothing else
      const r = await call("threads.quick", { purpose: "helper", system: SYSTEM, prompt: `App: ${app}`, spend_purpose: "vault-template", timeout_ms: 45_000 }).catch(e => ({ error: { code: e && e.code, message: String(e && e.message) } }));
      if (!r || r.error || !r.data || r.data.ok === false) {
        const why = r && r.error && (r.error.code === "account_required" || r.error.code === "no_account" || isConnectOwn(r.error.message)) ? "no_account" : "no_answer";
        return { app, fields: [], source: "none", why };
      }
      const fields = cleanFields((firstJson(r.data.text) || {}).fields);
      if (!fields.length) return { app, fields: [], source: "none", why: "no_answer" };
      write({ ...read(), [key]: { app, fields, at: now() } });
      return { app, fields, source: "ai" };
    },
  };
}

/** @param {{ ctx: any, vault: import("../vault.js").Vault, tool: (name: string, callers: string[]|null, description: string, input: any, run: Function, needs?: any) => void }} o */
export function register({ ctx, vault, tool }) {
  const t = makeTemplates({ dir: vault.dir, call: (_name, input) => ctx.call("threads.quick", input) });
  const person = (/** @type {any} */ meta) => { if (isAsker(String(meta && meta.caller))) throw bad("App templates are the person's own; an agent or a model does not ask for them.", "denied"); };

  tool("vault.templates", PEOPLE, "This Space's app templates for the Vault's Add sheet: each app's field names, plain or secret, and where to find each. Never a value.",
    obj({}), async (/** @type {any} */ _i, /** @type {any} */ meta) => { person(meta); return { templates: t.list() }; });

  tool("vault.template.suggest", PEOPLE, "An app's usual Vault fields: this Space's template, or a suggestion from your own AI account, which is sent the app's name only. Kept as a template.",
    obj({ app: str }, ["app"]), async (/** @type {any} */ { app }, /** @type {any} */ meta) => { person(meta); return t.suggest(app); });
}
