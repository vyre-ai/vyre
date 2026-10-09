#!/usr/bin/env node
// gen-agent-docs: the parts of the agent docs (docs/agents) that are written from the code, so they cannot go stale, and the checks that hold the whole set to its contract.
//
//   node scripts/gen-agent-docs.mjs            write the generated blocks
//   node scripts/gen-agent-docs.mjs --check    exit 1 if a block is stale or the set breaks its contract (writes nothing)
//
// Each generated block sits between `<!-- agent:NAME:start -->` and `<!-- agent:NAME:end -->`. What is generated: the outward kinds, the tool families and reach classes, the record field kinds and the Kits' types,
// the Flow step kinds, the connections that ship and their operations, every error code with its next step, and the page index. What a step or a code MEANS is written below, once; a code or step kind with no
// words here fails the check, so a new one cannot ship without telling agents what to do.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadCorpus } from "../lib/docs-corpus.js";
import { tokens } from "../lib/tokens.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

/** What a Flow step does, in one line. */
export const STEP_HELP = {
  find: "read records of a type with a filter", pick: "choose one record from what was found", filter: "keep the items that match a condition", create: "make a record", update: "change a record",
  upsert: "update a record if it exists, else make it", remove: "delete a record (may be held)", decide: "branch: then one list of steps, else another", repeat: "do steps for each item (bounded)",
  wait: "pause until a time or an event", ask: "ask a person a question and wait for the answer", assign: "give work to a person or agent as a task", call: "run a tool of the Space",
  stage: "move a record to a stage", agent: "give one job to an agent", classify: "label text with a fixed set of choices", extract: "pull named fields out of text", service: "run a connection's operation",
  fn: "run a short piece of code in a sandbox (no network)",
};

/** Each error code: what it means and the one next step. Codes in the code and not here appear in a final line without advice. */
export const NEXT = {
  bad_input: "The input is malformed or a field is missing. Read the message, fix the input, call again.",
  not_found: "Absent, or you may not see it (the two look the same). Do not retry. Say what you could not read, or ask the person for access.",
  not_allowed: "Your chain may not do this. Do not retry or work around it. Ask the person, or request a grant.",
  denied: "Refused by a rule. Read the message; ask the person if you need it.",
  needs_presence: "A person must prove they are there (a signature on their own device). Tell them what waits and where.",
  needs_approval: "A person must approve first. The act is held as a task. Tell them; do not repeat the call.",
  needs_confirmation: "The act needs the person to confirm the exact words. Show them and wait.",
  chain_not_person: "This act needs a chain that is exactly one person. An agent cannot do it. Ask the person to do it.",
  not_a_member: "You or the person are not a member of this Space. Do not retry.",
  wrong_space: "The call names a different Space than this chain. Use the right Space's chain.",
  bad_state: "The thing is in the wrong state for this (for example a task already done). Read its state and choose a legal next step.",
  version_conflict: "Someone changed it since you read it. Read again, then decide whether your change still applies.",
  idem_conflict: "The same request key was used for different input. Make a new key.",
  unavailable: "The service is not ready or reachable right now. Wait and retry a few times, then tell the person.",
  unreachable: "The other machine did not answer. Retry once; then tell the person it seems to be offline.",
  timeout: "It took too long. Retry once with a smaller request; then tell the person.",
  rate_limited: "Too many calls. Wait, then continue slower. Do not loop.",
  unsupported: "This is not supported here (the machine, the store or the version). Do not retry; tell the person.",
  invalid: "The value is not valid. Read the message and correct it.",
  unknown_type: "No such record type in this Space. Ask `records.types` for what exists.",
  unknown_field: "No such field on that type. Ask `records.types` for the fields.",
  field_required: "A required field is missing. Fill it or ask the person.",
  field_not_allowed: "That field may not be set by you. Leave it out.",
  field_not_shown: "The field is not shown to this caller. Leave it out.",
  sealed: "The value is sealed. Use the placeholder; never ask for the value.",
  sealed_value_refused: "A sealed value was refused where it may not go. Use the placeholder.",
  placeholder_unreadable: "The placeholder could not be resolved for this act. Do not guess; tell the person which field.",
  secret_refused: "A secret was found in text you sent. Remove it and use the vault or a placeholder.",
  draft_only: "This connection or tool only drafts. Make a draft; a person sends it.",
  stage_not_in_set: "That stage does not exist for the type. Read the stages and choose one.",
  stage_entry_refused: "The record may not enter that stage yet. Read the message for what is missing.",
  stage_tasks_open: "Open tasks block this stage. Finish or skip them first.",
  rule_failed: "A rule of the Space refused the change. Read the message and fix what it names.",
  no_checker: "The task needs a checker and has none. Ask the person to name one.",
  same_actor: "The doer and the checker may not be the same. Ask for a different checker.",
  changed_since_approval: "The act changed after the person approved. It will be held again; tell them.",
  used_up: "A one-time proof or approval was already used. Ask for a new one.",
  expired: "It ran out of time (a proof, an approval, a code). Ask for a new one.",
  budget_exhausted: "The spend or token budget is used up. Stop and tell the person.",
  cloud_required: "This needs a Cloud space (a server). Tell the person.",
  not_contained: "The sandbox could not confine this. It will not run. Tell the person.",
  key_custody: "The machine cannot keep keys safely, so this will not start. Tell the person; do not retry.",
  module_down: "The module behind this tool is not running. Wait and retry once; then tell the person.",
  module_failed: "The module failed to start. Tell the person; do not retry.",
  log_rolled_back: "The Space's log was rolled back. Stop. A person must look.",
  log_broken: "The Space's log does not verify. Stop. A person must look.",
  unique_violation: "A record with that unique value exists. Find it instead of creating another.",
  moved: "The thing moved. Follow the new address in the message.",
  too_large: "The input or output is too large. Send less or ask for less.",
};

const cell = (s) => String(s).replace(/\|/g, "/").replace(/\n/g, " ");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

async function outwardBlock() {
  const { OUTWARD_RISKS } = await imp("kernel/contracts/index.js");
  const { OUTWARD_KINDS } = await imp("records/connectors/format.js");
  return [
    `Outward acts are: ${OUTWARD_RISKS.map((r) => `\`${r.replace("outward.", "")}\``).join(", ")} (the kernel's outward risks). A tool or a connection operation carries the mark; the mark, not your wish, decides.`,
    `A connection's operation is outward when its kind is ${[...OUTWARD_KINDS].map((k) => `\`${k}\``).join(", ")}. Reading and drafting are not.`,
  ].join("\n\n");
}

async function toolsBlock() {
  const fam = new Map();
  for (const t of ["core", "local", "modules"]) for (const d of fs.readdirSync(path.join(ROOT, t))) {
    const f = path.join(ROOT, t, d, "module.json");
    if (!fs.existsSync(f)) continue;
    const m = JSON.parse(fs.readFileSync(f, "utf8"));
    const n = ((m.does && m.does.tools) || []).length;
    if (n) fam.set(m.name, (fam.get(m.name) || 0) + n);
  }
  const reaches = /const REACHES = \[([^\]]*)\]/.exec(read("core/modules/index.js"))[1].split(",").map((x) => x.trim().replace(/"/g, ""));
  const fams = [...fam.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(", ");
  return [`Reach classes: ${reaches.map((r) => `\`${r}\``).join(", ")}.`, `Tool families, each a module name and how many tools it has: ${fams}.`].join("\n\n");
}

async function recordsBlock() {
  const { FIELD_KINDS } = await imp("kernel/contracts/index.js");
  const kits = fs.readdirSync(path.join(ROOT, "records/kits"), { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, "records/kits", e.name, "kit.json"))).map((e) => e.name).sort();
  const lines = kits.map((id) => { const k = JSON.parse(read(`records/kits/${id}/kit.json`)); return `- \`${id}\`: ${(k.types || []).map((t) => t.name).join(", ")}.`; });
  return [`Field kinds: ${FIELD_KINDS.map((k) => `\`${k}\``).join(", ")}.`, "Kits that ship, and the record types each adds:", ...lines].join("\n\n").replace(/\n\n- /g, "\n- ");
}

async function flowsBlock() {
  const { STEP_KINDS, LIMITS } = await imp("kernel/flows/schema.js");
  const rows = STEP_KINDS.map((k) => `| \`${k}\` | ${cell(STEP_HELP[k] || "(not described yet)")} |`);
  return [`A Flow has up to ${LIMITS.steps} steps, nested up to ${LIMITS.depth} deep, and a repeat runs at most ${LIMITS.repeatMax} times.`, "| Step | What it does |\n| --- | --- |\n" + rows.join("\n")].join("\n\n");
}

async function connectionsBlock() {
  const { DECLARATIONS } = await imp("records/connectors/index.js");
  const { KINDS } = await imp("records/connectors/format.js");
  const lines = Object.values(DECLARATIONS).map((d) => `- \`${d.id}\`: ${Object.entries(d.ops || {}).map(([n, o]) => `${n} (${o.kind})`).join(", ") || "see connectors.declared"}.`);
  return [`Operation kinds: ${[...KINDS].map((k) => `\`${k}\``).join(", ")}.`, "Connections that ship as declarations, with their operations:", ...lines].join("\n\n").replace(/\n\n- /g, "\n- ");
}

async function errorsBlock() {
  const found = new Set();
  const walk = (dir) => { for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) { if (e.name === "node_modules") continue; const r = `${dir}/${e.name}`; if (e.isDirectory()) walk(r); else if (/\.js$/.test(e.name) && !/\.test\.js$/.test(e.name)) for (const m of read(r).matchAll(/KernelError\("([a-z_]+)"/g)) found.add(m[1]); } };
  walk("kernel");
  const { REASON_CODES, STORE_ERROR_CODES } = await imp("kernel/contracts/index.js");
  for (const c of [...REASON_CODES, ...STORE_ERROR_CODES]) if (c !== "ok") found.add(c);
  const known = Object.keys(NEXT).filter((c) => found.has(c)).sort();
  const rest = [...found].filter((c) => !NEXT[c]).sort();
  const rows = known.map((c) => `| \`${c}\` | ${cell(NEXT[c])} |`);
  return ["| Code | What to do |\n| --- | --- |\n" + rows.join("\n"), rest.length ? `Other codes, which carry their own message: ${rest.map((c) => `\`${c}\``).join(", ")}.` : ""].filter(Boolean).join("\n\n");
}

export async function indexBlock() {
  const { agent } = loadCorpus(ROOT);
  const rows = agent.filter((p) => p.path !== "agents/index.md").map((p) => `| \`${p.path.replace(/^agents\//, "")}\` | ${cell(p.when)} | ${p.tokens} |`);
  return "| Page | Read it when | Tokens |\n| --- | --- | --- |\n" + rows.join("\n");
}

const BLOCKS = { outward: outwardBlock, tools: toolsBlock, records: recordsBlock, flows: flowsBlock, connections: connectionsBlock, errors: errorsBlock, index: indexBlock };
const FILES = { outward: "outward-acts.md", tools: "tools.md", records: "records.md", flows: "flows.md", connections: "connections.md", errors: "errors.md", index: "index.md" };
const mark = (n, end) => `<!-- agent:${n}:${end ? "end" : "start"} -->`;

/** One page's text with its generated block rewritten. */
export async function renderPage(name, text) {
  const a = text.indexOf(mark(name, false)), b = text.indexOf(mark(name, true));
  if (a < 0 || b < a) throw new Error(`docs/agents/${FILES[name]} has no ${mark(name, false)} ... ${mark(name, true)} pair`);
  return `${text.slice(0, a + mark(name, false).length)}\n\n${await BLOCKS[name]()}\n\n${text.slice(b)}`;
}

/** The index page is made last, from the other pages' own sizes, so it is rendered after the rest are final. */
export async function renderAll() {
  const out = {};
  for (const name of Object.keys(BLOCKS).filter((n) => n !== "index")) out[name] = await renderPage(name, read(`docs/agents/${FILES[name]}`));
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("gen-agent-docs.mjs")) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const pass of [1, 2]) {
    const out = await renderAll();
    for (const [name, text] of Object.entries(out)) { const f = path.join(ROOT, "docs/agents", FILES[name]); if (read(`docs/agents/${FILES[name]}`) !== text) { stale++; if (!check) fs.writeFileSync(f, text); } }
    if (pass === 1 && !check) continue;
    const idx = await renderPage("index", read("docs/agents/index.md"));
    if (read("docs/agents/index.md") !== idx) { stale++; if (!check) fs.writeFileSync(path.join(ROOT, "docs/agents/index.md"), idx); }
    break;
  }
  if (check) { if (stale) { console.error("docs/agents is out of date: run node scripts/gen-agent-docs.mjs"); process.exit(1); } console.log("docs/agents is current"); }
  else console.log(stale ? "docs/agents written" : "docs/agents already current");
}
