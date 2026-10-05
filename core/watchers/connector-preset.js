// @ts-check
// A watcher for any connector's poll (team/0.3/PLAN-platform-gaps-0.2.9.md, item 7): the connector's declaration (records/connectors) names a read op, where the list is in the answer, how
// an item is identified and how it is mapped; this fixed code does the rest, so a new service needs no watcher code of its own. The code only ever makes GET requests, to the one host the
// declaration names, with the credential the watcher was granted; what the declaration says is data in watch.js, so the folder's hash covers it and an edit needs a new dry run and a yes.
//
//   first run   notes where to start (quiet), unless the poll asks for a look-back of N days
//   each run    list since the last look (a 10 minute overlap, because an item is filed once however often it is seen), read each item's own record when the poll says to expand it,
//               map it, and emit it with its own id
//   items       carry the mapped fields as given (kind, at, subject, people, source_key ...) beside id, title and at, so a Flow armed on this watcher reads them as trigger.item

import { MAPPER_SOURCE } from "../../records/connectors/mapper.js";
import { buildRequest, checkDeclaration } from "../../records/connectors/format.js";
import { parseWhen } from "./when.js";

export const OVERLAP_MS = 10 * 60_000;

/** The generic loop. `PLAN` is prepended as JSON, `M` is the mapper. */
const LOOP = `
const OVERLAP = ${OVERLAP_MS};
function sub(t, vars) {
  return String(t).replace(/\\{(\\$?[a-z_]+)\\}/gi, (_m, k) => { const v = k.startsWith("$") ? vars[k.slice(1)] : vars[k]; if (v === undefined) throw new Error("the poll needs " + k); return String(v); });
}
function value(v, vars) { return Array.isArray(v) ? v.map(x => sub(x, vars)) : typeof v === "string" ? (v.startsWith("$") && !v.includes("{") ? String(vars[v.slice(1)]) : sub(v, vars)) : v; }
function url(host, path, params, query, vars) {
  const p = path.replace(/\\{([a-z_]+)\\}/gi, (_m, k) => encodeURIComponent(String(value(params[k], vars))));
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) for (const x of [].concat(value(v, vars))) q.append(k, x);
  const s = q.toString();
  return "https://" + host + p + (s ? "?" + s : "");
}
async function get(u, what) {
  const r = await fetch(u, { method: "GET", headers: { accept: "application/json" } });
  if (r.status === 404 && what === "item") return null;
  if (!r.ok) throw new Error(PLAN.label + " answered " + r.status);
  return r.json();
}
export default async function watch({ since, emit, log }) {
  const spec = JSON.parse(readFileSync(new URL("./watcher.json", import.meta.url), "utf8"));
  const now = Date.now();
  const vars = { ...(spec.params || {}) };
  delete vars.connector; delete vars.poll;
  if (!since || !since.at) {
    if (!PLAN.lookback_days) { log("starting from now"); return { at: now }; }
    since = { at: now - PLAN.lookback_days * 864e5 + OVERLAP };
  }
  const from = since.at - OVERLAP;
  Object.assign(vars, { since_s: Math.floor(from / 1000), since_iso: new Date(from).toISOString(), since_ms: from });
  let page = null, seen = 0;
  for (let pages = 0; pages < 5; pages++) {
    const query = { ...PLAN.list.query, ...(page ? { pageToken: page } : {}) };
    const body = await get(url(PLAN.host, PLAN.list.path, PLAN.list.params, query, vars), "list");
    const list = PLAN.items ? M.get(body, PLAN.items) : body;
    for (const raw0 of Array.isArray(list) ? list : []) {
      if (++seen > 200) { log("more than 200 new things in one look; the rest wait for the next"); return { at: from + OVERLAP }; }
      let raw = raw0;
      if (PLAN.expand) {
        const params = {};
        for (const [k, p] of Object.entries(PLAN.expand.args)) params[k] = String(M.get(raw0, p));
        raw = await get(url(PLAN.host, PLAN.expand.path, params, PLAN.expand.query, vars), "item");
        if (raw === null) continue;
      }
      const id = M.field(raw0 === raw ? raw : { ...raw0, ...raw }, PLAN.id, vars);
      if (id === undefined || id === null || id === "") { log("an item had no id and was skipped"); continue; }
      const item = M.mapItem(raw, PLAN.map, vars);
      // at becomes milliseconds when it is filed, so the time as the service gave it is kept, as text, in occurred
      emit({ ...item, id: String(id).slice(0, 200), title: item.title ?? item.subject ?? String(id), at: item.at ?? now, ...(typeof item.at === "string" ? { occurred: item.at } : {}) });
    }
    page = body && body.nextPageToken;
    if (!page || !PLAN.paged) break;
  }
  return { at: now };
}
`;

/**
 * @param {{ project: string, connector: import("../../records/connectors/format.js").Declaration, poll: string, credential: string, vars?: Record<string, string>, when?: string, label?: string, lookback_days?: number }} o
 */
export function connectorPreset(o) {
  const d = o.connector, poll = d && d.poll && d.poll[o.poll];
  if (!d || checkDeclaration(d).length) throw new Error("a connector preset needs a valid connector declaration");
  if (!poll) throw new Error(`${d.id} has no poll ${o.poll}; it has ${Object.keys(d.poll || {}).join(", ") || "none"}`);
  if (typeof o.credential !== "string" || !o.credential) throw new Error("a connector preset needs credential: the name of the vault credential for this connector");
  const listOp = d.ops[poll.op], expandOp = poll.expand ? d.ops[poll.expand.op] : null;
  const vars = o.vars || {};
  // Every name the plan substitutes must be given, so a poll never runs with a hole in its request.
  const text = JSON.stringify([poll.args, poll.map, poll.id, poll.expand]);
  const needed = [...new Set([...text.matchAll(/\$([a-z_]+)/g)].map(m => m[1]))].filter(n => !["since_s", "since_iso", "since_ms"].includes(n));
  for (const n of needed) if (typeof vars[n] !== "string" || !vars[n] || vars[n].length > 200) throw new Error(`${d.id} ${o.poll} needs ${n} (for example the mailbox address)`);
  const extra = Object.keys(vars).filter(k => !needed.includes(k));
  if (extra.length) throw new Error(`${d.id} ${o.poll} has no use for ${extra.join(", ")}`);
  // Ask the declaration to build the list request once, with a sample for each declared shape, so a request it does not allow is refused now and not at the first run.
  const sample = (/** @type {any} */ sh, /** @type {any} */ v) => (!sh ? v : sh.type === "number" ? 1 : sh.type === "time" ? "2026-01-01T00:00:00Z" : sh.type === "boolean" ? true : sh.type === "array" ? (Array.isArray(v) ? v : [v]) : v);
  const shapes = listOp.input || {};
  buildRequest(d, poll.op, { params: Object.fromEntries(Object.keys(poll.args?.params || {}).map(k => [k, "x"])),
    query: Object.fromEntries(Object.entries(poll.args?.query || {}).map(([k, v]) => [k, sample(shapes.query?.[k], v)])) });
  const lookback = o.lookback_days === undefined ? poll.since?.lookback_days : Number(o.lookback_days);
  if (lookback !== undefined && !(Number.isInteger(lookback) && lookback >= 0 && lookback <= 90)) throw new Error("lookback_days is 0 to 90");
  const every = poll.every_minutes ?? 15;
  const when = o.when === undefined ? (every < 60 ? `every ${every} minutes` : "hourly") : String(o.when);
  const t = parseWhen(when);
  const plan = {
    label: poll.label || d.label, host: new URL(d.base_url).hostname, items: poll.items, id: poll.id, map: poll.map, paged: Boolean(listOp.input?.query?.pageToken),
    ...(lookback ? { lookback_days: lookback } : {}),
    list: { path: listOp.path, params: poll.args?.params || {}, query: poll.args?.query || {} },
    ...(poll.expand && expandOp ? { expand: { path: expandOp.path, args: poll.expand.args, query: poll.expand.query || {} } } : {}),
  };
  const code = `// Polls ${d.label} (${o.poll}) and files each new item. Generated from the connector's declaration; read-only.\nimport { readFileSync } from "node:fs";\nconst PLAN = ${JSON.stringify(plan)};\nconst M = ${MAPPER_SOURCE};\n${LOOP}`;
  const slug = (/** @type {string} */ s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const name = `${slug(d.id)}-${slug(o.label || Object.values(vars)[0] || o.poll)}`.slice(0, 60).replace(/-+$/, "");
  return { name, code, json: {
    name, project: o.project, schedule: t.schedule, emits: `${slug(d.id)}.found`, timeout: 120, memory: false, params: { connector: d.id, poll: o.poll, ...vars },
    net: { [plan.host]: { credential: o.credential } },
    summary: { when: `${when[0].toUpperCase()}${when.slice(1)}`, check: `${plan.label}: every new item the connector's poll finds, mapped as the declaration says (no model)`,
      do: `Files each as an item that a Flow can read. Nothing in ${d.label} is changed.` } } };
}
