// @ts-check
// `vyre learn`: the lessons Vyre learned from the user, and the ones it proposed. Adding,
// accepting, retiring and re-levelling a lesson are the user's calls, so they live here too.

import { call } from "../../daemon/client.js";
import { out, dim, bold, signal, beacon } from "../style.js";

const LEVELS = ["remind", "ask", "block"];
const unreachable = r => r.error && ["unreachable", "timeout"].includes(r.error.code);
const fail = r => { out(unreachable(r) ? `  vyred is not running ${dim("· vyre up to start it")}` : beacon(`  ${r.error.code}: `) + r.error.message); return 1; };

/** One lesson on one line, with its check and counts underneath. */
function line(l) {
  const mark = l.status === "proposed" ? beacon("?") : signal("·");
  out(`  ${mark} ${bold(String(l.id))} ${l.status === "retired" ? dim(l.rule) : l.rule} ${dim(`[${l.level}]`)}`);
  const counts = `applied ${l.applied} · caught ${l.caught} · broken ${l.broken}`;
  out(dim(`      ${[l.check ? `checks ${l.check.label || l.check.kind}` : "no check, a reminder", counts].join(" · ")}`));
  if (l.status === "proposed") out(dim(`      vyre learn accept ${l.id} · vyre learn retire ${l.id}`));
}

/** An id from args, or a usage line and null. */
const idOf = (args, usage) => {
  const id = Number(args[0]);
  if (!Number.isInteger(id) || id < 1) { out(`  ${usage}`); return null; }
  return id;
};

/** Run a tool that returns one lesson, and show it. */
async function one(tool, input, said) {
  const r = await call(tool, input);
  if (r.error) return fail(r);
  out(`  ${said} ${bold(String(r.data.id))}`);
  line(r.data);
  return 0;
}

export default {
  name: "learn", aliases: ["lessons"], order: 32, usage: "vyre learn [add|accept|retire|level]", summary: "the lessons Vyre learned from you, and what it proposed",
  async run(args) {
    const [sub, ...rest] = args;
    if (!sub) {
      const r = await call("learn.lessons", {});
      if (r.error) return fail(r);
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
      if (!text) { out("  vyre learn add <text>"); return 1; }
      return one("learn.add", { text }, "learned lesson");
    }
    if (sub === "accept" || sub === "retire") {
      const id = idOf(rest, `vyre learn ${sub} <id>`);
      if (id === null) return 1;
      return one(`learn.${sub}`, { id }, sub === "accept" ? "accepted lesson" : "retired lesson");
    }
    if (sub === "level") {
      const id = idOf(rest, "vyre learn level <id> <remind|ask|block>");
      if (id === null) return 1;
      if (!LEVELS.includes(rest[1])) { out("  vyre learn level <id> <remind|ask|block>"); return 1; }
      return one("learn.edit", { id, level: rest[1] }, "changed lesson");
    }
    out(`  vyre learn ${sub}: ${dim("add, accept, retire or level")}`);
    return 1;
  },
};
