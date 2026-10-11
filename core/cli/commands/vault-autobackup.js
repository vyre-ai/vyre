// @ts-check
// `vyre vault autobackup` and `vyre vault restore --drill`: the daily automatic backup and the drill that proves it restores (G20).
// Split from vault.js, which may not grow; the helpers it shares with the other vault verbs are imported from there.

import path from "node:path";
import { hiddenPrompt } from "../../vault/cli-io.js";
import { dim, bold, signal } from "../style.js";
import { say, tool, fail, oops, secretGate, plural, day } from "./vault.js";

/** `vyre vault autobackup enrol|status|run`: the daily automatic backup (G20). */
export async function autobackupCmd(args) {
  const verb = args[0];
  if (verb === "status" || !verb) {
    const r = await tool("vault.autobackup.status", {});
    if (r.error) return fail(r);
    const d = r.data;
    if (!d.enrolled) { say(`  ${dim("automatic backups are off")}  ·  turn them on: vyre vault autobackup enrol`); return 0; }
    say(`  ${signal("automatic backups on")} ${dim(`· the newest ${d.keep} are kept`)}`);
    say(`  last backup   ${d.last ? `${day(d.last.at)} · ${plural(d.last.items, "item")}` : dim("none yet")}`);
    say(`  restore drill ${d.drill ? `${day(d.drill.at)} · ${d.drill.ok ? signal("passed") : bold("FAILED")} ${dim(`· ${d.drill.note}`)}` : dim("not run yet: vyre vault restore --drill")}`);
    return 0;
  }
  if (verb === "run") {
    const r = await tool("vault.autobackup.run", {}, { timeout: 120_000 });
    if (r.error) return fail(r);
    say(`  ${signal("backed up")} ${plural(r.data.items, "item")} to ${bold(r.data.file)}`);
    return 0;
  }
  if (verb === "enrol") {
    const gate = secretGate("Your recovery code");
    if (gate !== null) return gate;
    let code;
    try { code = (await hiddenPrompt("recovery code: ")).trim(); } catch { return oops("cancelled"); }
    const r = await tool("vault.autobackup.enrol", { code }, { timeout: 120_000 });
    code = "";
    if (r.error) return fail(r);
    say(`  ${signal("automatic backups are on")} ${dim("· every day, sealed to your recovery code, the newest 14 kept")}`);
    say(dim("  run the drill now to be sure they open: vyre vault restore --drill"));
    return 0;
  }
  return oops("vyre vault autobackup [status | enrol | run]");
}

/** `vyre vault restore --drill [<file>]`: restore the newest automatic backup into a scratch vault and compare it with this one. Nothing in this vault changes. */
export async function drillCmd(file) {
  const gate = secretGate("Your recovery code");
  if (gate !== null) return gate;
  let code;
  try { code = (await hiddenPrompt("recovery code: ")).trim(); } catch { return oops("cancelled"); }
  const r = await tool("vault.autobackup.drill", { code, ...(file ? { file: path.resolve(file) } : {}) }, { timeout: 180_000 });
  code = "";
  if (r.error) return fail(r);
  const d = r.data;
  say(`  ${d.ok ? signal("the drill passed") : bold("the drill FAILED")} ${dim(`· ${d.file} · ${d.note}`)}`);
  if (d.newer.length) say(dim(`  changed since the backup: ${d.newer.join(", ")}`));
  for (const n of d.missing) say(`  missing: ${n}`);
  for (const n of d.changed) say(`  different: ${n}`);
  return d.ok ? 0 : 1;
}
