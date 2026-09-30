// @ts-check
// ghl: GoHighLevel automations, end to end, at human speed or faster.
//
// GoHighLevel is a single-page app on app.gohighlevel.com or app.leadconnectorhq.com (or a
// white-label host the person adds under chrome.storage.local "ghl.hosts"). Nothing here is
// GoHighLevel-specific plumbing: it is a context reader, a section navigator that reuses the tab
// already open, a save verifier, and a flow runner that compiles a declarative flow into ONE
// batch.run, so the whole automation costs one host round trip and no per-step model turn. Where
// the app has its own internal API, the faster path is api.learn on the tab once, then api.call
// (ADR 0049); flows and API calls compose in the same batch because both are ops.
//
// Robustness is the page module's job and every step here leans on it: page.act and page.fill wait
// for a control to exist, be enabled and hold still, ride out spinners and stale re-renders,
// dismiss a "what's new" or cookie popup and refuse (describing it) to touch an unsaved-changes or
// confirm dialog, and every result carries a `trace` (which selector strategy matched, whether it
// was a fallback, how long it waited, how many retries, whether a tab was opened). A failure's
// error carries `detail`: the tab's host and path, the trace, and a small masked snippet of the page.
//
// Selectors give both an identifier (the fixture's data-testid) and a visible name, and the page
// module binds on whichever the page has, so one flow reads the fixture and the real app. The
// visible names below are GoHighLevel's labels as documented; they are unverified against a live
// account (the person's run is the acceptance check, ADR 0049 "Known limits"). A flow can always be
// given inline as `steps`, so a wrong label is a one-line override, not a code change. Optional
// steps (a search box, a confirm button the app may not have) never fail a flow: a step that finds
// nothing says `skipped` in its result.

import { err } from "../lib/err.js";
import { getGhlHosts } from "../shared/ghlhosts.js";
import { matchControl, norm, labelOf, describeBlocker, traceOf } from "../lib/ui.js";
import { resolve, failDetail } from "./page.js";

const DEFAULT_HOSTS = ["app.gohighlevel.com", "app.leadconnectorhq.com"];

/** Left-nav sections and the path GoHighLevel serves each at. */
export const SECTIONS = {
  contacts: "contacts", conversations: "conversations", opportunities: "opportunities", calendars: "calendars",
  workflows: "automation/workflows", automation: "automation/workflows", marketing: "marketing", sites: "sites",
  payments: "payments", reputation: "reputation", reporting: "reporting", settings: "settings",
};

/** The left-nav entry that opens each section (visible name, and the fixture's identifier). */
const NAV = {
  contacts: ["Contacts", "nav-contacts"], conversations: ["Conversations", "nav-conversations"], opportunities: ["Opportunities", "nav-opportunities"],
  calendars: ["Calendars", "nav-calendars"], workflows: ["Automation", "nav-automation"], automation: ["Automation", "nav-automation"],
  marketing: ["Marketing", "nav-marketing"], sites: ["Sites", "nav-sites"], payments: ["Payments", "nav-payments"],
  reputation: ["Reputation", "nav-reputation"], reporting: ["Reporting", "nav-reporting"], settings: ["Settings", "nav-settings"],
};

/** A control that proves a section has really rendered, when the app has a well-known one. Any one of them will do. */
const LANDMARKS = {
  contacts: [{ name: "Add Contact", identifier: "add-contact" }],
  workflows: [{ name: "Create Workflow", identifier: "create-workflow" }],
  automation: [{ name: "Create Workflow", identifier: "create-workflow" }],
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

// ---------------------------------------------------------------- flow steps

/** How long a flow step waits for its control to exist, be enabled and hold still. */
export const STEP_WAIT = { timeoutMs: 8000, stable: true };
/** An optional step looks briefly and moves on. */
const OPTIONAL_WAIT = { timeoutMs: 1500, stable: true };

/**
 * Put a name and an identifier on one control; the binder takes whichever the page has.
 * @param {string} name @param {string} [id] @param {string} [role]
 */
const sel = (name, id, role) => ({ ...(role ? { role } : {}), name, ...(id ? { identifier: id } : {}) });
const step = (/** @type {string} */ label, /** @type {string} */ op, /** @type {any} */ args) => ({ op, label, args });
const click = (/** @type {string} */ name, /** @type {string} */ id, /** @type {{ optional?: boolean }} */ o = {}) =>
  step(`click ${name}`, "page.act", { selector: sel(name, id), kind: "click", wait: o.optional ? OPTIONAL_WAIT : STEP_WAIT, ...(o.optional ? { optional: true } : {}) });
const fill = (/** @type {string} */ name, /** @type {string} */ id, /** @type {string} */ value) =>
  step(`fill ${name}`, "page.fill", { fields: [{ selector: sel(name, id), value }], wait: STEP_WAIT });
/** Fill fields by their visible label; a label the page does not have is reported, never skipped silently. */
const labelled = (/** @type {string} */ what, /** @type {Record<string, any>} */ values, /** @type {{ optional?: boolean }} */ o = {}) =>
  step(what, "page.fill", { fields: Object.entries(values).map(([k, v]) => ({ label: labelOf(k), value: v, ...(o.optional ? { optional: true } : {}) })), partial: true, wait: o.optional ? OPTIONAL_WAIT : STEP_WAIT });

const kebab = (/** @type {string} */ s) => norm(s).replace(/ /g, "-");
const title = (/** @type {string} */ s) => String(s).replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());

/** The action types a flow understands: the label the builder shows and the names a caller may use. */
export const ACTIONS = {
  "send-email": { label: "Send Email", aka: ["email"] },
  "send-sms": { label: "Send SMS", aka: ["sms", "text", "send-text"] },
  "wait": { label: "Wait", aka: ["delay"] },
  "add-tag": { label: "Add Tag", aka: ["add-contact-tag", "tag"] },
  "remove-tag": { label: "Remove Tag", aka: ["remove-contact-tag"] },
  "if-else": { label: "If/Else", aka: ["if", "condition", "branch"] },
  "webhook": { label: "Webhook", aka: ["custom-webhook"] },
  "update-contact-field": { label: "Update Contact Field", aka: ["update-field", "set-field"] },
  "create-opportunity": { label: "Create Opportunity", aka: ["opportunity", "create-update-opportunity"] },
};

/** @param {string} type @returns {{ id: string, label: string }} */
export function actionOf(type) {
  const k = kebab(String(type));
  const hit = Object.entries(ACTIONS).find(([id, a]) => id === k || a.aka.includes(k));
  return hit ? { id: hit[0], label: hit[1].label } : { id: k, label: title(String(type)) };
}

/**
 * A config as steps. An object maps visible labels to values (a key like messageBody or
 * message_body reads as "message body"); {select: "Option"} on a label opens that dropdown and
 * picks the option. A string is the old single-field form and needs a field named "Action
 * configuration".
 * @param {any} cfg
 */
function configSteps(cfg) {
  if (cfg === undefined || cfg === null || cfg === "") return [];
  if (typeof cfg !== "object" || Array.isArray(cfg)) return [fill("Action configuration", "action-config", String(cfg))];
  /** @type {any[]} */ const out = [];
  /** @type {Record<string, any>} */ let run = {};
  const flush = () => { if (Object.keys(run).length) out.push(labelled(`fill ${Object.keys(run).map(labelOf).join(", ")}`, run)); run = {}; };
  for (const [k, v] of Object.entries(cfg)) {
    if (v && typeof v === "object" && ("select" in v || "pick" in v)) {
      flush();
      const want = String(v.select ?? v.pick);
      out.push(step(`open ${labelOf(k)}`, "page.act", { selector: { name: labelOf(k) }, kind: "click", fillable: true, wait: STEP_WAIT }));
      out.push(click(want, undefined));
    } else run[k] = v;
  }
  flush();
  return out;
}

/** @param {{ trigger: string, triggerConfig?: any, search?: boolean }} p */
function triggerSteps(p) {
  const name = /[A-Z ]/.test(String(p.trigger)) ? String(p.trigger) : title(String(p.trigger));
  return [
    click("Add New Workflow Trigger", "trigger-picker"),
    ...(p.search === false ? [] : [step("search triggers", "page.fill", { fields: [{ label: "Search", value: name, optional: true }], partial: true, wait: OPTIONAL_WAIT })]),
    click(name, `trigger-${kebab(String(p.trigger))}`),
    ...configSteps(p.triggerConfig),
    click("Save Trigger", "trigger-confirm", { optional: true }),
  ];
}

/** @param {{ type: string, config?: any, search?: boolean }} a */
function actionSteps(a) {
  const t = actionOf(a.type);
  return [
    click("Add Action", "add-action"),
    ...(a.search === false ? [] : [step("search actions", "page.fill", { fields: [{ label: "Search", value: t.label, optional: true }], partial: true, wait: OPTIONAL_WAIT })]),
    click(t.label, `action-${t.id}`),
    ...configSteps(a.config),
    click("Save Action", "action-confirm"),
  ];
}

const saveStep = (/** @type {any} */ expect) => step("save the workflow", "ghl.save", { name: "Save", identifier: "save-workflow", ...(expect ? { expect } : {}) });
const open = (/** @type {any} */ p) => (p.open ? [step("open Workflows", "ghl.section", { section: "workflows", ...(p.locationId ? { locationId: p.locationId } : {}) })] : []);

/**
 * The flow library. Each flow takes params and returns batch steps (each with a `label` a failure
 * can name). Adding a flow is adding an entry here, or passing `steps` inline.
 * @type {Record<string, { about: string, params: Record<string, string>, steps: (p: any) => any[] }>}
 */
export const FLOWS = {
  "create-workflow": {
    about: "Build a workflow from scratch: a trigger and any number of actions, then save (and optionally publish).",
    params: { name: "workflow name", trigger: "trigger, e.g. contact-created or 'Contact Created'", triggerConfig: "{label: value} for the trigger's own fields", actions: "[{type: send-email|send-sms|wait|add-tag|remove-tag|if-else|webhook|update-contact-field|create-opportunity, config: {label: value}}]", save: "false to skip the save", publish: "true to publish after saving", open: "true to go to Workflows first" },
    steps: p => {
      const acts = Array.isArray(p.actions) ? p.actions : [];
      return [
        ...open(p),
        click("Create Workflow", "create-workflow"),
        click("Start from Scratch", undefined, { optional: true }),
        fill("Workflow Name", "workflow-name", String(p.name)),
        ...(p.trigger ? triggerSteps({ trigger: p.trigger, triggerConfig: p.triggerConfig }) : []),
        ...acts.flatMap(actionSteps),
        ...(p.save === false ? [] : [saveStep()]),
        ...(p.publish === true ? publishSteps("published") : []),
      ];
    },
  },
  "add-trigger": {
    about: "In the open workflow builder, add a trigger and fill its fields.",
    params: { trigger: "trigger name or id", triggerConfig: "{label: value}", save: "true to save after" },
    steps: p => [...triggerSteps(p), ...(p.save === true ? [saveStep()] : [])],
  },
  "add-action": {
    about: "In the open workflow builder, add one action (email, sms, wait, add/remove tag, if/else, webhook, update contact field, create opportunity).",
    params: { type: "action type", config: "{label: value}", save: "true to save after" },
    steps: p => [...actionSteps(p), ...(p.save === true ? [saveStep()] : [])],
  },
  "edit-workflow": {
    about: "Open an existing workflow by name and optionally rename it, change its trigger, append actions, then save.",
    params: { name: "the workflow's current name", rename: "new name", trigger: "new trigger", triggerConfig: "{label: value}", actions: "[{type, config}] to append", save: "false to skip the save", open: "true to go to Workflows first" },
    steps: p => {
      const acts = Array.isArray(p.actions) ? p.actions : [];
      return [
        ...open(p),
        step("search workflows", "page.fill", { fields: [{ label: "Search", value: String(p.name), optional: true }], partial: true, wait: OPTIONAL_WAIT }),
        step(`open ${p.name}`, "page.act", { selector: { name: String(p.name) }, kind: "click", wait: STEP_WAIT }),
        ...(p.rename ? [fill("Workflow Name", "workflow-name", String(p.rename))] : []),
        ...(p.trigger ? triggerSteps({ trigger: p.trigger, triggerConfig: p.triggerConfig }) : []),
        ...acts.flatMap(actionSteps),
        ...(p.save === false ? [] : [saveStep()]),
      ];
    },
  },
  "save-workflow": {
    about: "Save the open workflow and verify it saved (toast, disabled Save, URL change or list item).",
    params: { listItem: "a name that should appear in the list after saving" },
    steps: p => [saveStep(p.listItem ? { listItem: String(p.listItem) } : undefined)],
  },
  "publish-workflow": {
    about: "Set the open workflow's status: published or draft, then save and verify. Publishing is held for the person's approval unless they asked for it.",
    params: { status: "published (default) or draft" },
    steps: p => publishSteps(p.status === "draft" ? "draft" : "published"),
  },
  "open-contact": {
    about: "Open a contact from the contacts list by its row number (0 is the first row).",
    params: { row: "row number" },
    steps: p => [click("Contacts", "nav-contacts"), click("Open contact", `contact-row-${Number(p.row) || 0}`)],
  },
};

/** The status toggle, then a save that checks the toggle stuck. Publishing is a consequential click, so the page module holds it for the Gate. @param {"published"|"draft"} status */
function publishSteps(status) {
  const name = status === "published" ? "Publish" : "Draft";
  return [click(name, status === "published" ? "publish-toggle" : "draft-toggle"), saveStep({ status })];
}

/** Fill a "{param}" template: only whole-string {name} placeholders, nothing evaluated. @param {any} v @param {any} params */
function fillTemplate(v, params) {
  if (typeof v === "string") { const m = /^\{([a-z][a-z0-9_]*)\}$/i.exec(v); return m && m[1] in params ? params[m[1]] : v; }
  if (Array.isArray(v)) return v.map(x => fillTemplate(x, params));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillTemplate(x, params)]));
  return v;
}

/** @param {any} ctx */
async function hostsOf(ctx) {
  try { const s = await ctx.storage.get("local", "ghl.hosts"); return [...DEFAULT_HOSTS, ...(Array.isArray(s) ? s.map(String) : []), ...getGhlHosts()]; } catch { return [...DEFAULT_HOSTS, ...getGhlHosts()]; }
}

/** @param {any} ctx @param {any} args */
async function tabOf(ctx, args) {
  if (typeof args.tabId === "number") return ctx.tabs.get(args.tabId);
  const a = await ctx.tabs.active();
  return a && typeof a === "object" ? a : ctx.tabs.get(a);
}

/** @param {string} u */
const pathOnly = u => { try { const x = new URL(String(u)); return x.host + x.pathname; } catch { return String(u).split(/[?#]/)[0]; } };

/** @param {any} ctx @param {number} ms */
const nap = async (ctx, ms) => { if (ctx.stopped()) throw err("stopped"); await new Promise(r => setTimeout(r, ms)); };

// ---------------------------------------------------------------- loading a section

/**
 * Wait until a section has really loaded: the route changed (or its landmark control appeared, for
 * an app that routes without changing the URL), the page's own loading spinners are gone, the DOM
 * and network are quiet, and the landmark control is there. A default landmark is a guess at the
 * app's labels, so its absence after the page settles is a warning; a landmark the caller named
 * is required.
 * @param {any} ctx @param {number} tabId @param {string} section @param {any[]} landmarks @param {boolean} required @param {number} timeoutMs @param {string[]} hosts
 */
async function loaded(ctx, tabId, section, landmarks, required, timeoutMs, hosts) {
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  const landmarkHere = async () => {
    if (!landmarks.length) return false;
    const snap = await ctx.call("page.snapshot", { tabId });
    return landmarks.some(l => matchControl(l, snap.controls, resolve).control);
  };
  // 1. The route: the URL shows the section and the tab is done loading, or the landmark is already on screen.
  for (;;) {
    const tab = await ctx.tabs.get(tabId);
    const urlOk = parse(tab.url, hosts).section === section && tab.status !== "loading";
    if (urlOk || (landmarks.length && await landmarkHere())) break;
    if (Date.now() >= deadline) throw err("timeout", `the ${section} section did not load in ${timeoutMs} ms`, await failDetail(ctx, tabId, { trace: { strategy: "url", waitedMs: Date.now() - t0 } }));
    await nap(ctx, 100);
  }
  // 2. Spinners gone, DOM and network quiet.
  const flags = (await ctx.call("page.wait", { tabId, settled: true, timeoutMs: Math.max(200, deadline - Date.now()) })).trace || {};
  // 3. The landmark control.
  let found = await landmarkHere();
  const graceEnd = required ? deadline : Math.min(deadline, Date.now() + 1000);
  while (landmarks.length && !found && Date.now() < graceEnd) { await nap(ctx, 100); found = await landmarkHere(); }
  if (landmarks.length && !found && required) throw err("timeout", `the ${section} section loaded but the control that marks it did not appear`, await failDetail(ctx, tabId, { trace: { strategy: "landmark", waitedMs: Date.now() - t0 } }));
  return { landmark: landmarks.length ? found : null, waitedMs: Date.now() - t0, flags: { ...(flags.busyIgnored ? { busyIgnored: true } : {}), ...(flags.domNeverQuiet ? { domNeverQuiet: true } : {}), ...(flags.netIgnored ? { netIgnored: true } : {}) } };
}

// ---------------------------------------------------------------- saving

const SAVED = /\b(saved|save successful|success|successfully|updated|published|created|done)\b/i;
const FAILED = /\b(error|failed|failure|could not|couldn'?t|unable|invalid|required|denied|went wrong|not saved)\b/i;

/** @type {{ name: string, ops: Record<string, (args: any, ctx: any) => Promise<any>> }} */
export default {
  name: "ghl",
  ops: {
    "ghl.context": async (args, ctx) => {
      const t = await tabOf(ctx, args);
      const info = parse(t && t.url, await hostsOf(ctx));
      return { tab: t && t.id, ...info, trace: traceOf({ strategy: "tab", waitedMs: 0 }) };
    },

    "ghl.section": async (args, ctx) => {
      const section = String(args.section);
      const path = SECTIONS[/** @type {keyof typeof SECTIONS} */ (section)];
      if (!path) throw err("bad_request", `unknown section ${JSON.stringify(args.section)}; one of ${Object.keys(SECTIONS).join(", ")}`);
      const t0 = Date.now();
      const hosts = await hostsOf(ctx);
      const ghlTabs = (await ctx.tabs.query({})).filter((/** @type {any} */ t) => parse(t.url, hosts).isGhl);
      // Reuse the tab already on GoHighLevel: the one on the same sub-account if one is named, else the one in front, else the first.
      const found = (args.locationId && ghlTabs.find((/** @type {any} */ t) => parse(t.url, hosts).locationId === args.locationId)) || ghlTabs.find((/** @type {any} */ t) => t.active) || ghlTabs[0];
      const loc = args.locationId || (found && parse(found.url, hosts).locationId);
      if (!loc) throw err("bad_request", found ? "no location id: open a sub-account first or pass locationId" : "no GoHighLevel tab is open and no locationId was given; open it once or pass locationId (Vyre never opens a tab it can reuse)");
      const host = found ? /** @type {string} */ (parse(found.url, hosts).host) : String(args.host || DEFAULT_HOSTS[0]);
      const url = `https://${host}/v2/location/${loc}/${path}`;
      let tabId, newTab = false;
      if (found) tabId = found.id;
      else {
        // Nothing to reuse: open one tab, once (tabs.use reuses by origin and path first, so a second call never opens another).
        const u = await ctx.call("tabs.use", { url, openIfMissing: true, focus: false, asked: args.asked === true });
        tabId = u.id; newTab = u.reused === false;
      }
      const landmarks = args.landmark ? [typeof args.landmark === "string" ? { name: args.landmark } : args.landmark] : (/** @type {any} */ (LANDMARKS)[section] || []);
      const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 15_000, 1000), 120_000);
      const here = found ? parse(found.url, hosts) : { section: undefined, locationId: undefined };
      /** @type {string} */ let via;
      let fallback = false;
      if (found && here.section === (section === "automation" ? "workflows" : section) && here.locationId === loc && args.reload !== true) via = "already";
      else if (!found) via = "url";
      else {
        const [navName, navId] = /** @type {any} */ (NAV)[section];
        via = "url";
        if (args.via !== "url") {
          // Inside the app: click the left nav, so the single-page app routes itself and no page reloads.
          try {
            const r = await ctx.call("page.act", { tabId, selector: sel(navName, navId), kind: "click", wait: { timeoutMs: 1500, stable: true }, optional: true, asked: args.asked === true });
            if (r && r.ok && !r.skipped) via = "nav";
          } catch (e) {
            if (/** @type {any} */ (e)?.code === "stopped" || /** @type {any} */ (e)?.code === "modal") throw e;
          }
          fallback = via !== "nav";
        }
        if (via === "url") await ctx.call("tabs.navigate", { tabId, url, asked: args.asked === true });
      }
      const r = await loaded(ctx, tabId, section === "automation" ? "workflows" : section, landmarks, !!args.landmark, timeoutMs, hosts);
      return { ok: true, tab: tabId, section, via, loaded: true, landmark: r.landmark, ...(r.landmark === false ? { warning: "the section settled but its usual landmark control was not found; the app's labels may differ" } : {}), url: url.replace(/^https:\/\//, ""), ms: Date.now() - t0, trace: traceOf({ strategy: via, fallback, waitedMs: r.waitedMs, retries: 0, newTab, ...r.flags }) };
    },

    "ghl.flows": async () => ({ flows: Object.entries(FLOWS).map(([name, f]) => ({ name, about: f.about, params: f.params })), actions: Object.entries(ACTIONS).map(([id, a]) => ({ id, label: a.label })) }),

    "ghl.save": async (args, ctx) => {
      const tab = await tabOf(ctx, args);
      if (!tab) throw err("no_tab");
      const tabId = tab.id;
      const t0 = Date.now();
      const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 8000, 500), 60_000);
      const target = args.selector || sel(String(args.name || "Save"), args.identifier ? String(args.identifier) : undefined);
      const expect = args.expect && typeof args.expect === "object" ? args.expect : {};
      const before = await ctx.call("page.snapshot", { tabId });
      const seen = new Set(((before.state && before.state.toasts) || []).map((/** @type {any} */ x) => x.text));
      const wasEnabled = (() => { const c = matchControl(target, before.controls, resolve).control; return c ? c.enabled !== false : false; })();
      const act = await ctx.call("page.act", { tabId, selector: target, kind: "click", wait: STEP_WAIT, asked: args.asked === true });
      if (act && act.held) return act;
      const tClick = Date.now();
      const trace = (/** @type {any} */ x) => traceOf({ ...(act && act.trace ? act.trace : {}), waitedMs: Date.now() - t0, ...(x || {}) });
      const fail = async (/** @type {string} */ code, /** @type {string} */ msg, /** @type {any} */ extra) => err(code, msg, await failDetail(ctx, tabId, { trace: trace(), extra }));
      if (!act || act.ok === false) throw await fail("not_saved", `save step: ${act && act.why ? act.why : "the Save control could not be pressed"}`);
      /** @type {{ kind: string, text?: string }|null} */ let evidence = null;
      let lastSnap = before;
      while (!evidence) {
        await nap(ctx, 100);
        const snap = lastSnap = await ctx.call("page.snapshot", { tabId });
        const st = snap.state || {};
        const top = (st.blockers || []).filter((/** @type {any} */ b) => b.modal).pop();
        if (top) throw await fail("modal", `saving opened a dialog: ${JSON.stringify((top.title || top.text || "").slice(0, 80))}. It was not dismissed; read it and act on one of its own controls.`, { blockers: [describeBlocker(top, snap)] });
        for (const x of st.toasts || []) {
          const fresh = x.ageMs === null || x.ageMs === undefined ? !seen.has(x.text) : x.ageMs <= Date.now() - tClick + 300;
          if (!fresh) continue;
          if (FAILED.test(x.text)) throw await fail("not_saved", `save step: the app reported a problem: ${JSON.stringify(String(x.text).slice(0, 120))}`, { toast: String(x.text).slice(0, 120) });
          if (expect.toast ? norm(x.text).includes(norm(expect.toast)) : SAVED.test(x.text)) { evidence = { kind: "toast", text: String(x.text).slice(0, 120) }; break; }
        }
        if (evidence) break;
        if (pathOnly(snap.url) !== pathOnly(before.url)) { evidence = { kind: "url" }; break; }
        if (expect.listItem && (snap.controls.some((/** @type {any} */ c) => norm(c.name) === norm(expect.listItem)) || norm(snap.text).includes(norm(expect.listItem)))) { evidence = { kind: "list", text: String(expect.listItem).slice(0, 60) }; break; }
        const now = matchControl(target, snap.controls, resolve).control;
        if (wasEnabled && now && now.enabled === false && (st.netPending === 0 || st.netPending === undefined) && Date.now() - tClick >= 300) { evidence = { kind: "save-disabled" }; break; }
        if (Date.now() - t0 >= timeoutMs) throw await fail("not_saved", `save step: not confirmed after ${timeoutMs} ms (no success toast, disabled Save, URL change or list item)`);
      }
      if (expect.status) {
        const want = String(expect.status).toLowerCase();
        const sw = lastSnap.controls.find((/** @type {any} */ c) => ["switch", "checkbox"].includes(c.role) && /publish|draft/i.test(String(c.name || c.identifier || "")));
        if (!sw) throw await fail("not_saved", `save step: saved, but the Draft/Publish switch was not found, so the status ${want} could not be verified`);
        const is = sw.checked ? "published" : "draft";
        if (is !== want) throw await fail("not_saved", `save step: saved, but the workflow status is ${is}, not ${want}`);
      }
      return { ok: true, saved: true, evidence, waitedMs: Date.now() - t0, ...(expect.status ? { status: String(expect.status) } : {}), trace: trace({ evidence: evidence.kind }) };
    },

    "ghl.run": async (args, ctx) => {
      let steps;
      let name = "inline";
      if (Array.isArray(args.steps)) {
        steps = fillTemplate(args.steps, args.params || {});
        // An inline step gets the same patience a flow's steps have, unless it sets its own.
        steps = steps.map((/** @type {any} */ s) => s && (s.op === "page.act" || s.op === "page.fill") && s.args && typeof s.args === "object" && s.args.wait === undefined ? { ...s, args: { ...s.args, wait: STEP_WAIT } } : s);
      } else {
        const f = FLOWS[String(args.flow)];
        if (!f) throw err("bad_request", `no such flow ${JSON.stringify(args.flow)}; ghl.flows lists them`);
        name = String(args.flow);
        steps = f.steps(args.params || {});
      }
      if (!steps.length) throw err("bad_request", "the flow has no steps");
      const t0 = Date.now();
      const r = await ctx.call("batch.run", { steps, stopOnError: true, asked: args.asked === true });
      const ms = Date.now() - t0;
      const traces = (Array.isArray(r.results) ? r.results : []).map((/** @type {any} */ x) => x && x.trace).filter(Boolean);
      const trace = traceOf({ strategy: "batch", fallback: traces.some((/** @type {any} */ x) => x.fallback), waitedMs: traces.reduce((/** @type {number} */ a, /** @type {any} */ x) => a + (x.waitedMs || 0), 0), retries: traces.reduce((/** @type {number} */ a, /** @type {any} */ x) => a + (x.retries || 0), 0), newTab: traces.some((/** @type {any} */ x) => x.newTab) });
      const failed = r.ok === false && typeof r.failedAt === "number" ? { step: r.failedAt, label: steps[r.failedAt] && steps[r.failedAt].label, op: steps[r.failedAt] && steps[r.failedAt].op } : undefined;
      return { flow: name, ...r, ...(failed ? { failed } : {}), ms, perStepMs: steps.length ? Math.round((ms / steps.length) * 10) / 10 : 0, steps: steps.length, trace };
    },
  },
};
