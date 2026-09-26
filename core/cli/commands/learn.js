// @ts-check
// `vyre learn`: the lessons Vyre learned from the user, and the ones it proposed. Adding,
// accepting, retiring and re-levelling a lesson are the user's calls, so they live here too.

import { call } from "../../daemon/client.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { json, emit, failTool, usage } from "../kit.js";

const LEVELS = ["remind", "ask", "block"];
const fail = r => failTool(r.error);

/** One lesson on one line, with its check and counts underneath. */
function line(l) {
  const mark = l.status === "proposed" ? beacon("?") : signal("·");
  out(`  ${mark} ${bold(String(l.id))} ${l.status === "retired" ? dim(l.rule) : l.rule} ${dim(`[${l.level}]`)}`);
  const counts = `applied ${l.applied} · caught ${l.caught} · broken ${l.broken}`;
  out(dim(`      ${[l.check ? `checks ${l.check.label || l.check.kind}` : "no check, a reminder", counts].join(" · ")}`));
  if (l.status === "proposed") out(dim(`      vyre learn accept ${l.id} · vyre learn retire ${l.id}`));
}

/** An id from args, or null. */
const idOf = args => {
  const id = Number(args[0]);
  if (!Number.isInteger(id) || id < 1) return null;
  return id;
};

/** Run a tool that returns one lesson, and show it. */
async function one(tool, input, said) {
  const r = await call(tool, input);
  if (r.error) return fail(r);
  if (json()) return emit(r.data);
  out(`  ${said} ${bold(String(r.data.id))}`);
  line(r.data);
  return 0;
}

export default {
  name: "learn", aliases: ["lessons"], order: 32, usage: "vyre learn [add|accept|retire|level] [--json]", summary: "the lessons Vyre learned from you, and what it proposed",
  async run(args) {
    const [sub, ...rest] = args.filter(a => a !== "--json");
    if (!sub || sub === "list" || sub === "ls") {
      const r = await call("learn.lessons", {});
      if (r.error) return fail(r);
      if (json()) return emit(r.data);
      const active = r.data.filter(l => l.status === "active"), proposed = r.data.filter(l => l.status === "proposed");
      if (!r.data.length) { out(dim("  no lessons yet · vyre learn add <what Claude should always or never do>")); return 0; }
      out(`\n  ${signal(active.length + " lesson" + (active.length === 1 ? "" : "s"))} ${dim(proposed.length ? `· ${proposed.length} waiting for your yes` : "")}\n`);
      for (const l of active) line(l);
      if (proposed.length) { out(""); out(beacon("  proposed")); for (const l of proposed) line(l); }
      out("");
      return 0;
    }
    if (sub === "add") {
      const text = rest.join(" ").trim();
      if (!text) return usage("vyre learn add needs the lesson", "vyre learn add <what Claude should always or never do>");
      return one("learn.add", { text }, "learned lesson");
    }
    if (sub === "accept" || sub === "retire") {
      const id = idOf(rest);
      if (id === null) return usage(`vyre learn ${sub} needs a lesson number`, "vyre learn lists them with their numbers");
      return one(`learn.${sub}`, { id }, sub === "accept" ? "accepted lesson" : "retired lesson");
    }
    if (sub === "level") {
      const id = idOf(rest);
      if (id === null || !LEVELS.includes(rest[1])) return usage("vyre learn level <id> remind|ask|block", `vyre learn level ${id || 1} remind`);
      return one("learn.edit", { id, level: rest[1] }, "changed lesson");
    }
    return usage(`vyre learn ${sub}: not a subcommand`, "vyre learn add, accept, retire or level");
  },
};
