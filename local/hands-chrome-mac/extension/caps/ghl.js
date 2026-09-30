// @ts-check
// ghl: GoHighLevel automations, end to end, at human speed or faster.
//
// GoHighLevel is a single-page app on app.gohighlevel.com or app.leadconnectorhq.com (or a
// white-label host the person adds under chrome.storage.local "ghl.hosts"). Nothing here is
// GoHighLevel-specific plumbing: it is a context reader, a section navigator that reuses the tab
// already open, and a flow runner that compiles a declarative flow into ONE batch.run, so the whole
// automation costs one host round trip and no per-step model turn. Where the app has its own
// internal API, the faster path is api.learn on the tab once, then api.call (ADR 0049); flows and
// API calls compose in the same batch because both are ops.
//
// Selectors give both an identifier (the fixture's data-testid) and a visible name, and the page
// module binds on whichever the page has, so one flow reads the fixture and the real app. The
// visible names below are GoHighLevel's labels as documented; they are unverified against a live
// account (the person's run is the acceptance check, ADR 0049 "Known limits"). A flow can always be
// given inline as `steps`, so a wrong label is a one-line override, not a code change.

import { err } from "../lib/err.js";

const DEFAULT_HOSTS = ["app.gohighlevel.com", "app.leadconnectorhq.com"];

/** Left-nav sections and the path GoHighLevel serves each at. */
export const SECTIONS = {
  contacts: "contacts", conversations: "conversations", opportunities: "opportunities", calendars: "calendars",
  workflows: "automation/workflows", automation: "automation/workflows", marketing: "marketing", sites: "sites",
  payments: "payments", reputation: "reputation", reporting: "reporting", settings: "settings",
};

/** @param {string} url @param {string[]} hosts */
export function parse(url, hosts = DEFAULT_HOSTS) {
  let u;
  try { u = new URL(String(url)); } catch { return { isGhl: false }; }
  if (!hosts.includes(u.hostname)) return { isGhl: false };
  const m = /\/(?:v2\/)?location\/([A-Za-z0-9]{10,40})(?:\/([^?#]*))?/.exec(u.pathname);
  const rest = m && m[2] ? m[2].replace(/\/+$/, "") : "";
  const section = Object.entries(SECTIONS).find(([, p]) => rest === p || rest.startsWith(p + "/"));
  return { isGhl: true, host: u.hostname, locationId: m ? m[1] : undefined, section: section ? section[0] : rest.split("/")[0] || undefined };
}

/**
 * Put a name and an identifier on one control; the binder takes whichever the page has.
 * @param {string} name @param {string} [id] @param {string} [role]
 */
const sel = (name, id, role) => ({ ...(role ? { role } : {}), name, ...(id ? { identifier: id } : {}) });
const click = (/** @type {string} */ name, /** @type {string} */ id) => ({ op: "page.act", args: { selector: sel(name, id), kind: "click" } });
const fill = (/** @type {string} */ name, /** @type {string} */ id, /** @type {string} */ value) => ({ op: "page.fill", args: { fields: [{ selector: sel(name, id), value }] } });

/**
 * The flow library. Each flow takes params and returns batch steps. Adding a flow is adding an
 * entry here, or passing `steps` inline.
 * @type {Record<string, { about: string, params: Record<string, string>, steps: (p: any) => any[] }>}
 */
export const FLOWS = {
  "create-workflow": {
    about: "Build a workflow from scratch: a trigger and any number of actions, then save.",
    params: { name: "workflow name", trigger: "trigger id, e.g. contact-created", actions: "[{type: send-email|wait|add-tag, config}]" },
    steps: p => {
      const acts = Array.isArray(p.actions) ? p.actions : [];
      return [
        click("Create Workflow", "create-workflow"),
        click("Add New Workflow Trigger", "trigger-picker"),
        click(String(p.trigger), `trigger-${p.trigger}`),
        fill("Workflow Name", "workflow-name", String(p.name)),
        ...acts.flatMap((a) => [
          click("Add Action", "add-action"),
          click(String(a.type), `action-${a.type}`),
          fill("Action configuration", "action-config", String(a.config ?? "")),
          click("Save Action", "action-confirm"),
        ]),
        click("Save", "save-workflow"),
      ];
    },
  },
  "open-contact": {
    about: "Open a contact from the contacts list by its row number (0 is the first row).",
    params: { row: "row number" },
    steps: p => [click("Contacts", "nav-contacts"), click("Open contact", `contact-row-${Number(p.row) || 0}`)],
  },
};

/** Fill a "{param}" template: only whole-string {name} placeholders, nothing evaluated. @param {any} v @param {any} params */
function fillTemplate(v, params) {
  if (typeof v === "string") { const m = /^\{([a-z][a-z0-9_]*)\}$/i.exec(v); return m && m[1] in params ? params[m[1]] : v; }
  if (Array.isArray(v)) return v.map(x => fillTemplate(x, params));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillTemplate(x, params)]));
  return v;
}

/** @param {any} ctx */
async function hostsOf(ctx) {
  try { const s = await ctx.storage.get("local", "ghl.hosts"); return Array.isArray(s) ? [...DEFAULT_HOSTS, ...s.map(String)] : DEFAULT_HOSTS; } catch { return DEFAULT_HOSTS; }
}

/** @param {any} ctx @param {any} args */
async function tabOf(ctx, args) {
  if (typeof args.tabId === "number") return ctx.tabs.get(args.tabId);
  const a = await ctx.tabs.active();
  return a && typeof a === "object" ? a : ctx.tabs.get(a);
}

/** @type {{ name: string, ops: Record<string, (args: any, ctx: any) => Promise<any>> }} */
export default {
  name: "ghl",
  ops: {
    "ghl.context": async (args, ctx) => {
      const t = await tabOf(ctx, args);
      const info = parse(t && t.url, await hostsOf(ctx));
      return { tab: t && t.id, ...info };
    },

    "ghl.section": async (args, ctx) => {
      const path = SECTIONS[/** @type {keyof typeof SECTIONS} */ (String(args.section))];
      if (!path) throw err("bad_request", `unknown section ${JSON.stringify(args.section)}; one of ${Object.keys(SECTIONS).join(", ")}`);
      const hosts = await hostsOf(ctx);
      const found = (await ctx.tabs.query({})).find((/** @type {any} */ t) => parse(t.url, hosts).isGhl);
      if (!found) throw err("no_tab", "no GoHighLevel tab is open; open it once and ask again (Vyre never opens a tab it can reuse)");
      const info = parse(found.url, hosts);
      const loc = args.locationId || info.locationId;
      if (!loc) throw err("bad_request", "no location id: open a sub-account first or pass locationId");
      const url = `https://${info.host}/v2/location/${loc}/${path}`;
      return ctx.call("tabs.navigate", { tabId: found.id, url, asked: args.asked === true });
    },

    "ghl.flows": async () => ({ flows: Object.entries(FLOWS).map(([name, f]) => ({ name, about: f.about, params: f.params })) }),

    "ghl.run": async (args, ctx) => {
      let steps;
      let name = "inline";
      if (Array.isArray(args.steps)) steps = fillTemplate(args.steps, args.params || {});
      else {
        const f = FLOWS[String(args.flow)];
        if (!f) throw err("bad_request", `no such flow ${JSON.stringify(args.flow)}; ghl.flows lists them`);
        name = String(args.flow);
        steps = f.steps(args.params || {});
      }
      if (!steps.length) throw err("bad_request", "the flow has no steps");
      const t0 = Date.now();
      const r = await ctx.call("batch.run", { steps, stopOnError: true, asked: args.asked === true });
      const ms = Date.now() - t0;
      return { flow: name, ...r, ms, perStepMs: steps.length ? Math.round((ms / steps.length) * 10) / 10 : 0, steps: steps.length };
    },
  },
};
