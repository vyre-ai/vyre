#!/usr/bin/env node
// @ts-check
// names-table: proposes `<area>.<object>.<verb>` names and generated descriptions for EVERY tool, from the manifests and the grammar in team/contracts/nomenclature.md, as one rename table
// (lib/tool-names-table.json). The old name stays as an alias; owners review only their own area's rows (`review: true` rows are the ones the script could not place with confidence).
//   node scripts/names-table.mjs            print the summary and the rows that need a person
//   node scripts/names-table.mjs --write    write lib/tool-names-table.json
//   node scripts/names-table.mjs --area mail   only that area's rows, for an owner's review
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { harvest } from "./lib/docs/reference.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const VERBS = ["list", "get", "find", "create", "update", "delete", "send", "run", "start", "stop", "open", "check", "propose", "approve", "export", "import", "grant", "revoke", "reveal"];
/** effect class from the verb (nomenclature.md section 1) */
export const EFFECT = { list: "read", get: "read", find: "read", check: "read", propose: "propose", create: "write", update: "write", delete: "write", run: "write", start: "write", stop: "write", open: "write", send: "send", approve: "send", export: "read", import: "write", grant: "access", revoke: "access", reveal: "access" };

export const AREAS = {
  memory: "what was said, decided and learned, and saved facts", records: "records, projects, tasks and goals", team: "teammates, agents and the assistant", chat: "chats, sessions, models and what they cost",
  flows: "automations, watchers, schedules and their runs", time: "reminders, agenda, calendar", mail: "email, texts, the Gate and anything sent to another person", files: "drive, folders, documents, artifacts",
  vault: "passwords, keys, connections to outside services and the MCP hub", computer: "a browser or desktop an agent drives", publish: "previews, publishing, apps and names", code: "GitHub, hooks, repos",
  spaces: "spaces, members, invites, devices, pairing, the runner and the network", system: "settings, updates, health, backups, appearance and brand", docs: "how-to pages, skills, tips and the tool finder", site: "learned operations on outside websites",
};

/** today's module prefix to area (nomenclature.md section 1) */
const PREFIX = {};
for (const [area, list] of Object.entries({
  memory: ["memory", "recall", "learn"], records: ["work", "projects", "goals", "tasks", "bridges", "sidebar", "records", "records-tools", "rules-tools", "roles", "tasks-tools"], team: ["team", "agents", "assistant"],
  chat: ["threads", "sessions", "models", "providers", "ask", "spend", "undo", "stream", "transcripts", "switchboard", "space-sessions"], flows: ["flows", "watchers", "reflex"], time: ["planner"],
  mail: ["mail", "google", "comms", "gate", "approvals", "waiting", "quiet", "push"], files: ["files", "glass", "artifacts", "documents", "sync", "attachments", "context", "store"],
  vault: ["vault", "connectors", "mcp", "outside"], computer: ["chrome", "hands", "computer", "computers", "sight", "term"], publish: ["previews", "publish", "appmods", "names", "apps", "builder", "design"],
  code: ["github", "hooks"], spaces: ["link", "relay", "wink", "runner", "onboard", "pluginagent", "spaces", "network", "signin", "spawner", "presence", "dockerproxy", "import", "export"],
  system: ["settings", "system", "update", "vitals", "appearance", "brand", "views", "commands", "events", "config", "daemon", "harness", "about", "modulelist", "modules", "resilience", "tips", "statusline", "event-catalog", "vyre-core", "vyre-index", "work"],
  docs: ["docs", "skills", "tips", "vyre"],
})) for (const p of list) if (!(p in PREFIX)) PREFIX[p] = area;

/** last segment (and a few two-word tails) to one of the 19 verbs */
const SYN = [
  [/^(list|ls|all|index|items|rows|recent|history|log|logs|timeline|queue|inbox|pending|waiting|attention|upcoming|agenda|today|next|tail|versions|members|accounts|devices|catalog)$/, "list"],
  [/^(get|show|read|view|status|info|describe|detail|details|card|preview|summary|current|state|whoami|self|ref|text|brief|situation|explain|snapshot|stats|usage|used-by|links|linked|granted|grants|resolve|lookup)$/, "get"],
  [/^(find|search|query|ask|match|retrieve|recall|suggest-find|discover)$/, "find"],
  [/^(create|add|new|make|define|draft|register|mint|compose|put|write|remember|record|post-new|enroll|install|connect|pair|offer|publish-new)$/, "create"],
  [/^(update|set|edit|change|rename|modify|patch|move|reorder|configure|toggle|enable|disable|mark|tag|link|unlink|bind|pin|unpin|archive|unarchive|label|switch|model|mode|effort|roll|rewind|retry|correct|fill|learn|teach|migrate|sync|refresh|reload|rotate|lease|release)$/, "update"],
  [/^(delete|remove|drop|forget|clear|purge|destroy|uninstall|unserve|unregister|discard|undo|rollback)$/, "delete"],
  [/^(send|post|reply|notify|message|share|forward|remind|publish|announce|invite|deliver|dm|text|email|call-out|release-send)$/, "send"],
  [/^(run|call|exec|execute|invoke|apply|simulate|trigger|fire|replay|dispatch|build|deploy|render|generate|resume|continue)$/, "run"],
  [/^(start|launch|begin|boot|spawn|wake)$/, "start"],
  [/^(stop|cancel|interrupt|halt|kill|pause|end|close|abort|suspend|quit)$/, "stop"],
  [/^(open|navigate|visit|goto|go|browse|click|type|screenshot|snapshot-page)$/, "open"],
  [/^(check|verify|test|probe|diagnose|health|validate|doctor|audit|lint|ping|vet|scan)$/, "check"],
  [/^(propose|suggest|request|ask-for|draft-change|offer-change)$/, "propose"],
  [/^(approve|accept|answer|decide|confirm|reject|deny|vouch|yes|no)$/, "approve"],
  [/^(export|download|backup|bundle|dump|save-out)$/, "export"],
  [/^(import|upload|restore|ingest|load|adopt|migrate-in)$/, "import"],
  [/^(grant|allow|lend|permit|authorize|give)$/, "grant"],
  [/^(revoke|disallow|withdraw|take-back)$/, "revoke"],
  [/^(reveal|unlock|copy|show-secret|decrypt|peek)$/, "reveal"],
];
const toVerb = (/** @type {string} */ seg, /** @type {boolean} */ readOnly) => {
  for (const [re, v] of SYN) if (re.test(seg)) return { verb: v, sure: true };
  return { verb: readOnly ? "get" : "update", sure: false };
};

/** sentence for a verb */
const PHRASE = { list: "List", get: "Get", find: "Find", create: "Create", update: "Change", delete: "Remove", send: "Send", run: "Run", start: "Start", stop: "Stop", open: "Open", check: "Check", propose: "Propose", approve: "Approve", export: "Export", import: "Import", grant: "Grant", revoke: "Revoke", reveal: "Reveal" };

/** The generated description: verb and object from the name, the area's own words, and the inputs the call needs. Never longer than 25 words. */
export function describe(/** @type {string} */ area, /** @type {string} */ object, /** @type {string} */ verb, /** @type {any} */ input) {
  const obj = object.replace(/[.-]/g, " ");
  const need = input && Array.isArray(input.required) ? input.required.slice(0, 4) : [];
  const held = verb === "send" ? " Held for the person's yes." : verb === "reveal" || verb === "grant" || verb === "revoke" ? " Needs the person." : "";
  const s = `${PHRASE[/** @type {keyof typeof PHRASE} */ (verb)]} ${obj} (${AREAS[/** @type {keyof typeof AREAS} */ (area)].split(",")[0]}).${need.length ? ` Needs: ${need.join(", ")}.` : ""}${held}`;
  return s.split(/\s+/).slice(0, 25).join(" ");
}

export function build() {
  const h = harvest();
  /** @type {Map<string, any>} */ const tools = new Map();
  for (const role of ["box", "local"]) for (const m of Object.values(/** @type {any} */ (h)[role])) for (const t of (/** @type {any} */ (m).tools || [])) if (!t.internal && !t.hook && !tools.has(t.name)) tools.set(t.name, t);
  /** @type {any[]} */ const rows = [];
  const taken = new Map();
  for (const t of [...tools.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const segs = String(t.name).split(".");
    const module = segs[0];
    // an object that belongs to another area wins over its module (a Google calendar is time, not mail)
    const area = /** @type {keyof typeof AREAS} */ (segs.includes("calendar") || segs.includes("agenda") ? "time" : PREFIX[module] || "system");
    const last = segs.length > 1 ? segs[segs.length - 1] : "get";
    const readOnly = t.effect === "read" || (t.effect === undefined && /^(list|get|find|read|show|status)/.test(last));
    const { verb, sure } = toVerb(last, readOnly);
    // the object: what stands between the module and the verb; a module that is not its own area keeps its name as the object's head
    const mid = segs.length > 2 ? segs.slice(1, -1) : [];
    const head = module === area || module === "vyre" ? [] : [module];
    const objParts = [...head, ...mid];
    const object = (objParts.length ? objParts.join(".") : area === module ? "" : module).replace(/\.+/g, ".");
    let name = [area, object, verb].filter(Boolean).join(".");
    if (name.split(".").length > 4) name = [area, ...objParts.slice(0, 2), verb].join(".");
    let review = !sure || !PREFIX[module];
    // a collision keeps more of the old name in the object, then a number; never a silent merge
    let tries = 0;
    while (name !== t.name && (taken.has(name) || tools.has(name)) && tries < 4) {
      tries++;
      const o = objParts.length ? [...objParts.slice(0, -1), objParts[objParts.length - 1] + (tries === 1 ? "-" + last : `-${last}-${tries}`)] : [last + (tries > 1 ? `-${tries}` : "")];
      name = [area, ...o.slice(0, 2), verb].join(".");
    }
    let clash = false;
    if (name !== t.name && (taken.has(name) || tools.has(name))) { name = t.name; clash = true; }
    taken.set(name, t.name);
    if (clash) review = true;
    rows.push({ old: t.name, name, area, object: object || null, verb, effect: EFFECT[/** @type {keyof typeof EFFECT} */ (verb)], review, ...(t.effect && t.effect !== EFFECT[/** @type {keyof typeof EFFECT} */ (verb)] && !(t.effect === "write" && ["send", "access"].includes(EFFECT[/** @type {keyof typeof EFFECT} */ (verb)])) ? { effect_was: t.effect } : {}), description: describe(area, object || area, verb, t.input), was: String(t.description || "").slice(0, 140) });
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = build();
  const only = process.argv.includes("--area") ? process.argv[process.argv.indexOf("--area") + 1] : null;
  if (process.argv.includes("--write")) { fs.writeFileSync(path.join(ROOT, "lib", "tool-names-table.json"), JSON.stringify({ version: 1, rows }, null, 1) + "\n"); console.log(`wrote lib/tool-names-table.json (${rows.length} rows)`); }
  const byArea = {};
  for (const r of rows) { const a = (byArea[r.area] ||= { rows: 0, review: 0 }); a.rows++; if (r.review) a.review++; }
  console.log(`${rows.length} tools, ${rows.filter((r) => r.review).length} need a person's look`);
  for (const [a, v] of Object.entries(byArea)) console.log(`  ${a.padEnd(9)} ${String(v.rows).padStart(4)} rows, ${String(v.review).padStart(4)} to review`);
  if (only) for (const r of rows.filter((x) => x.area === only)) console.log(`${r.review ? "?" : " "} ${r.old.padEnd(44)} -> ${r.name}`);
}
