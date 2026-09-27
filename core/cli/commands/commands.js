// @ts-check
// `vyre commands`: every command and its verbs, with their arguments and flags, as data. The
// Capsule's autocomplete and chat's / menu read `vyre commands --json`; a person gets the same
// list, shorter than `vyre help`. The shape is in docs/reference/cli-json.md.
//
// It runs without vyred: the list comes from the command files (core/cli/verbs.js), so it is
// there before `vyre up`.

import { commands, GROUPS } from "../index.js";
import { verbsOf, ownArgs } from "../verbs.js";
import { out, dim, bold } from "../style.js";
import { json, emit, parse, usage } from "../kit.js";

/** The shape's version: a surface that reads it checks this before anything else. */
export const SHAPE = 1;

/** @param {string} name */
const groupOf = name => (GROUPS.find(([, names]) => names.includes(name)) || ["More"])[0];

/**
 * The listing: one row per command, hidden ones only when asked.
 * @param {{ all?: boolean, only?: string }} [o]
 */
export async function listing({ all = false, only } = {}) {
  const rows = [];
  for (const c of await commands()) {
    if (c.hidden && !all) continue;
    if (only && c.name !== only && !(c.aliases || []).includes(only)) continue;
    const verbs = verbsOf(/** @type {any} */ (c));
    // A command with verbs may also take free words (vyre apps <words...>): it says so with its
    // own `args`, since its usage line's words are the verbs.
    const declared = /** @type {any} */ (c).args;
    const own = Array.isArray(declared) ? { args: declared, flags: /** @type {any} */ (c).flags || [] } : verbs.length ? null : ownArgs(c);
    const row = /** @type {any} */ ({ name: c.name, ...(c.aliases && c.aliases.length ? { aliases: c.aliases } : {}), summary: c.summary,
      group: groupOf(c.name), usage: c.usage || `vyre ${c.name}`, verbs });
    if (own) { row.args = own.args; row.flags = own.flags; }
    if (c.hidden) row.hidden = true;
    // Two files may share a name (`vyre threads`): one row, the verbs of both.
    const was = rows.find(r => r.name === row.name);
    if (was) { for (const v of verbs) if (!was.verbs.some(w => w.verb === v.verb)) was.verbs.push(v); continue; }
    rows.push(row);
  }
  return { v: SHAPE, commands: rows };
}

export default {
  name: "commands", order: 92, usage: "vyre commands [<command>] [--all] [--json]",
  summary: "every command and its verbs, as a list (--json for the Capsule and chat)",
  help: "Reads the command files, so it works before vyre up. --all includes hidden commands.",
  /** @param {string[]} args */
  async run(args) {
    const { flags, pos } = parse(args, { bool: ["all"], values: [], cmd: "commands" });
    if (pos.length > 1) return usage("vyre commands takes at most one command name");
    const data = await listing({ all: flags.all === true, only: pos[0] });
    if (pos[0] && !data.commands.length) return usage(`vyre ${pos[0]}: not a command`, "vyre commands lists them");
    if (json()) {
      return emit(data, { kind: "table", title: "Commands", columns: [{ key: "name", label: "Command" }, { key: "summary", label: "What it does" }],
        rows: data.commands.map(c => ({ name: c.name, summary: c.summary })) });
    }
    for (const c of data.commands) {
      out(`  ${bold("vyre " + c.name)} ${dim("· " + c.summary)}`);
      if (c.verbs.length) out(dim(`    ${c.verbs.map(v => v.verb).join(" · ")}`));
    }
    return 0;
  },
};
