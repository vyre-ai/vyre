// @ts-check
// `vyre watchers`: what the watcher runtime is running, and the same verbs Claude has: test,
// create, pause, resume, logs, items. Claude writes watchers; this is how a person looks after them.

import { call } from "../../daemon/client.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { json, emit, failTool, usage } from "../kit.js";

const fail = r => failTool(r.error);
const ago = iso => { if (!iso) return null; const m = Math.round((Date.now() - Date.parse(iso)) / 60_000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const until = iso => { if (!iso) return null; const m = Math.round((Date.parse(iso) - Date.now()) / 60_000); return m <= 0 ? "due now" : m < 60 ? `in ${m}m` : `in ${Math.round(m / 60)}h`; };
/** A time as the user reads it: local, to the minute. */
const local = t => { const d = new Date(t); const p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const STATE = { on: signal, paused: beacon, changed: beacon, invalid: beacon, missing: beacon, draft: dim };

/** Every verb run() handles, for `vyre commands --json`; run() refuses any other word. */
export const VERBS = [
  { verb: "list", aliases: ["ls"], summary: "every watcher: its state, schedule, what it filed and when it runs next (the default)", usage: "[--json]", read: true },
  { verb: "test", summary: "a dry run: what it would file, filing nothing", usage: "<name> [--json]" },
  { verb: "create", summary: "turn a watcher on", usage: "<name> [--json]" },
  { verb: "pause", summary: "stop it running until it is resumed", usage: "<name> [--json]" },
  { verb: "resume", summary: "run it again on its schedule", usage: "<name> [--json]" },
  { verb: "logs", summary: "its last ten runs", usage: "<name> [--json]", read: true },
  { verb: "items", summary: "what was filed, by one watcher or into one project", usage: "[name] [--json]", read: true },
];

/** The list as a table: one row per watcher, the columns a person scans. @param {{ dir: string, watchers: any[] }} d */
const table = d => ({ kind: "table", title: "Watchers",
  columns: [{ key: "name", label: "Watcher" }, { key: "state", label: "State" }, { key: "project", label: "Project" }, { key: "every", label: "Every" },
    { key: "items", label: "Filed" }, { key: "lastRun", label: "Last run" }],
  rows: d.watchers, empty: `No watchers yet: ask Claude to watch something; they live in ${d.dir}` });

function item(i) {
  out(`  · ${i.title || i.id}${i.url ? dim("  " + i.url) : ""}`);
  out(dim(`      ${[i.watcher, i.kind, i.at && local(i.at)].filter(Boolean).join(" · ")}`));
}

async function list() {
  const r = await call("watchers.list");
  if (r.error) return fail(r);
  if (json()) return emit(r.data, table(r.data));
  const { dir, watchers } = r.data;
  if (!watchers.length) { out(`  no watchers yet ${dim(`· ask Claude to watch something; they live in ${dir}`)}`); return 0; }
  out("");
  for (const w of watchers) {
    const paint = STATE[/** @type {keyof typeof STATE} */ (w.state)] || dim;
    out(`  ${bold(w.name)}  ${paint(w.state)}  ${dim([w.project, w.every].filter(Boolean).join(" · "))}`);
    const facts = [w.items + " filed", w.lastRun && "last " + ago(w.lastRun), w.next && "next " + until(w.next), w.failures && `${w.failures} failed`].filter(Boolean);
    out(dim(`      ${facts.join(" · ")}`));
    if (w.pausedWhy) out(beacon(`      ${w.pausedWhy}`));
    else if (w.lastError) out(beacon(`      ${w.lastError}`));
    for (const p of w.problems) out(beacon(`      ${p}`));
  }
  out(dim(`\n  ${dir}\n`));
  return 0;
}

export default {
  name: "watchers", order: 40, usage: "vyre watchers [list|test|create|pause|resume|logs|items] [name] [--json]",
  summary: "what the watchers are doing, and turning them on and off",
  verbs: VERBS,
  async run(args) {
    const [verb, ...rest] = args.filter(a => a !== "--json");
    const name = rest.join(" ").trim();
    if (!verb || verb === "list" || verb === "ls") return list();
    if (["test", "create", "pause", "resume", "logs"].includes(verb) && !name) return usage(`vyre watchers ${verb} needs a watcher's name`, "vyre watchers lists them");
    if (verb === "test") {
      const r = await call("watchers.test", { name }, { timeout: 330_000 });
      if (r.error) return fail(r);
      const d = r.data;
      if (json()) { emit(d); return d.ok ? 0 : 1; }
      if (!d.ok) { for (const p of d.problems || [d.error]) out(beacon("  " + p)); for (const l of d.logs || []) out(dim("    " + l)); return 1; }
      out(`\n  ${bold(name)} would file ${signal(d.count + " items")} ${dim(`into ${d.project || "?"} · ${d.every} · ${d.ms}ms`)}`);
      if (d.warning) out(beacon("  " + d.warning));
      for (const i of d.items.slice(0, 10)) item(i);
      if (d.note) out(dim("  " + d.note));
      out(dim(`\n  vyre watchers create ${name} to turn it on\n`));
      return 0;
    }
    if (verb === "create" || verb === "pause" || verb === "resume") {
      const r = await call(`watchers.${verb}`, { name });
      if (r.error) return fail(r);
      const d = r.data;
      if (json()) return emit(d);
      out(`  ${bold(name)} ${(STATE[/** @type {keyof typeof STATE} */ (d.state)] || dim)(d.state)}${d.every ? dim(" · " + d.every) : ""}${d.why ? dim(" · " + d.why) : ""}`);
      if (d.hook) out(dim(`  webhook: ${d.hook.method} ${d.hook.path} with header ${d.hook.header}: ${d.hook.token}`));
      return 0;
    }
    if (verb === "logs") {
      const r = await call("watchers.logs", { name, limit: 10 });
      if (r.error) return fail(r);
      if (json()) return emit(r.data);
      if (!r.data.length) { out(dim(`  ${name} has not run yet`)); return 0; }
      for (const run of r.data) {
        const head = `${local(run.at)} ${run.trigger}`;
        out(`  ${run.ok ? signal("ok") : beacon("failed")} ${dim(head)} ${run.ok ? dim(`${run.items} seen · ${run.filed} filed · ${run.ms}ms`) : run.error}`);
        for (const l of run.logs.slice(-5)) out(dim("      " + l));
      }
      return 0;
    }
    if (verb === "items") {
      // A name that is a watcher lists its items; anything else is taken as a project slug.
      const known = await call("watchers.list");
      if (known.error) return fail(known);
      const isWatcher = known.data.watchers.some(w => w.name === name);
      const r = await call("watchers.items", name ? (isWatcher ? { name } : { project: name }) : {});
      if (r.error) return fail(r);
      if (json()) return emit(r.data);
      if (!r.data.length) { out(dim("  nothing filed yet")); return 0; }
      for (const i of r.data) item(i);
      return 0;
    }
    return usage(`vyre watchers ${verb}: not a subcommand`, "vyre watchers list, test, create, pause, resume, logs or items");
  },
};
