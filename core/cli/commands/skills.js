// @ts-check
// `vyre skills`: the library through skills.browse (same path as the app and MCP).

import { call } from "../../daemon/client.js";
import { out, dim, bold } from "../style.js";
import { json, failTool, usage } from "../kit.js";

const skill = (name, about = "Use when the work is about this and nothing else.") => `---\nname: ${name}\ndescription: ${about}\n---\n\n# ${name}\n\nSteps.\n`;

function parse(args) {
  const flags = /** @type {Record<string, string|boolean>} */ ({}), words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) { words.push(a); continue; }
    const k = a.slice(2);
    if (k === "json") flags.json = true;
    else flags[k] = args[++i] ?? "";
  }
  return { flags, words };
}

async function browse(args) {
  const { flags, words } = parse(args);
  const level = typeof flags.level === "string" ? flags.level : words[0];
  const r = await call("skills.browse", { ...(level && level !== "browse" ? { level } : {}) });
  if (r.error) return failTool(r.error);
  if (flags.json) { json(r.data); return 0; }
  const rows = r.data.skills || [];
  if (!rows.length) { out(dim("  no skills at this level")); return 0; }
  for (const s of rows) {
    const chips = (s.harnesses || []).join(",");
    out(`  ${bold(s.name)}  ${s.level}${s.scope ? "/" + s.scope : ""}  ${chips ? `[${chips}]` : ""}`);
    if (s.description) out(dim(`    ${String(s.description).slice(0, 120)}`));
  }
  const drafts = r.data.drafts || [];
  if (drafts.length) out(dim(`  ${drafts.length} draft(s) waiting`));
  return 0;
}

async function draft(args) {
  const { flags, words } = parse(args);
  const name = words[0];
  if (!name) return usage("vyre skills draft <name>", "vyre skills draft <name> [--level space|personal|agent|project]");
  const level = typeof flags.level === "string" ? flags.level : "personal";
  const r = await call("skills.draft", { name, level, body: skill(name), kind: typeof flags.kind === "string" ? flags.kind : "skill", ...(typeof flags.scope === "string" ? { scope: flags.scope } : {}) });
  if (r.error) return failTool(r.error);
  if (flags.json) { json(r.data); return 0; }
  out(`  drafted ${name} v${r.data.version} (${r.data.level})`);
  return 0;
}

async function approve(args) {
  const { flags, words } = parse(args);
  const name = words[0], version = Number(words[1]);
  if (!name || !version) return usage("vyre skills approve <name> <version>", "vyre skills approve house-style 1");
  const level = typeof flags.level === "string" ? flags.level : "space";
  const r = await call("skills.approve", { name, level, version, ...(typeof flags.scope === "string" ? { scope: flags.scope } : {}), ...(typeof flags.ack === "string" ? { ack: flags.ack } : {}) });
  if (r.error) return failTool(r.error);
  if (flags.json) { json(r.data); return 0; }
  out(`  approved ${name} v${version}`);
  return 0;
}

async function decline(args) {
  const { flags, words } = parse(args);
  const name = words[0], version = Number(words[1]);
  if (!name || !version) return usage("vyre skills decline <name> <version>", "vyre skills decline house-style 2");
  const level = typeof flags.level === "string" ? flags.level : "space";
  const r = await call("skills.decline", { name, level, version });
  if (r.error) return failTool(r.error);
  if (flags.json) { json(r.data); return 0; }
  out(`  turned down ${name} v${version}`);
  return 0;
}

async function rollback(args) {
  const { flags, words } = parse(args);
  const name = words[0], to = Number(words[1]);
  if (!name || !to) return usage("vyre skills rollback <name> <version>", "vyre skills rollback house-style 1");
  const level = typeof flags.level === "string" ? flags.level : "space";
  const r = await call("skills.rollback", { name, level, to });
  if (r.error) return failTool(r.error);
  if (flags.json) { json(r.data); return 0; }
  out(`  rolled ${name} back to v${to}`);
  return 0;
}

export default {
  name: "skills",
  summary: "skills and plugins library (browse, draft, approve, decline, rollback)",
  usage: "vyre skills <browse|draft|approve|decline|rollback> ...",
  order: 44,
  async run(args) {
    const [sub, ...rest] = args;
    if (!sub || sub === "browse" || sub === "list") return browse(rest);
    if (sub === "draft") return draft(rest);
    if (sub === "approve") return approve(rest);
    if (sub === "decline") return decline(rest);
    if (sub === "rollback") return rollback(rest);
    return usage(`vyre skills ${sub}: not a subcommand`, "vyre skills browse | draft | approve | decline | rollback");
  },
};
