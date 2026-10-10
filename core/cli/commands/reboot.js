// @ts-check
// `vyre reboot`: restart this computer the planned way. On a Mac server with FileVault on, a plain restart stops at the login window and Vyre stays offline until someone types a password;
// `fdesetup authrestart` restarts and comes back to the desktop (the person types their password once, here). Anywhere else it is an ordinary restart. It never restarts without being told:
// it says what it will do, and asks (or needs --yes when there is no terminal).
//
// --json shape: reboot {plan: {cmd, args, how: "authrestart" | "restart", why}, restarted: boolean}

import { execFileSync, spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import { fileVault, authRestartSupported, plannedRestartCommand } from "../../../lib/online.js";
import { out, dim, bold, signal } from "../style.js";
import { EXIT, json, emit, fail, parse, usage, UsageError } from "../kit.js";

/**
 * What a planned restart will do on this computer, in words.
 * @param {(cmd: string, args: string[]) => string} run `fdesetup` and friends
 * @returns {{ cmd: string, args: string[], how: "authrestart" | "restart", why: string }}
 */
export function rebootPlan(run) {
  const c = plannedRestartCommand(run);
  if (c.args[0] === "authrestart") return { ...c, how: "authrestart", why: "FileVault is on: this restart goes straight back to the desktop and Vyre comes up by itself; your password is asked once" };
  const fv = fileVault(run);
  if (fv === "on") {
    return { ...c, how: "restart", why: `FileVault is on and this Mac cannot restart through it (${authRestartSupported(run) ? "it did not say so" : "authrestart is not supported here"}): after the restart it waits at the login window and Vyre is offline until someone types the password` };
  }
  return { ...c, how: "restart", why: fv === "off" ? "FileVault is off: an ordinary restart; Vyre comes back by itself" : "an ordinary restart; Vyre comes back by itself" };
}

/**
 * @param {string[]} args
 * @param {{ run?: (cmd: string, args: string[]) => string, spawn?: (cmd: string, args: string[]) => number, tty?: boolean, ask?: (q: string) => Promise<string>, uid?: number }} [deps]
 */
export async function reboot(args, deps = {}) {
  let flags;
  try { ({ flags } = parse(args, { bool: ["yes", "dry-run"], cmd: "reboot" })); }
  catch (e) { if (e instanceof UsageError) return usage(e.message, e.next); throw e; }
  const run = deps.run || ((cmd, a) => execFileSync(cmd, a, { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] }));
  const plan = rebootPlan(run);
  if (json()) { if (flags["dry-run"] || !flags.yes) return emit({ plan, restarted: false }, { kind: "card", title: "reboot", state: "ok", fields: [{ label: "How", value: plan.how }, { label: "Why", value: plan.why }] }); }
  else out(`  ${bold("Restart this computer")} ${dim(`· ${plan.how}`)}\n  ${plan.why}`);
  if (flags["dry-run"]) return EXIT.OK;
  if ((deps.uid ?? process.getuid?.() ?? -1) !== 0) return fail("restarting needs root", { code: "needs_root", next: "sudo vyre reboot" });
  const tty = deps.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!flags.yes) {
    if (!tty || json()) return usage("vyre reboot needs --yes when it cannot ask", "sudo vyre reboot --yes");
    const rl = deps.ask ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = (await (deps.ask ? deps.ask("  Restart now? (y/N) ") : /** @type {any} */ (rl).question("  Restart now? (y/N) "))).trim();
    rl?.close();
    if (!/^y(es)?$/i.test(a)) { out(dim("  nothing changed")); return EXIT.FAILED; }
  }
  const code = (deps.spawn || ((cmd, a) => spawnSync(cmd, a, { stdio: "inherit" }).status ?? 1))(plan.cmd, plan.args);
  if (code !== 0) return fail(`${plan.how === "authrestart" ? "fdesetup authrestart" : "the restart"} did not start (exit ${code})`, { code: "restart_failed", next: plan.how === "authrestart" ? "check the password, or restart from the Apple menu" : "restart from the Apple menu" });
  out(`  ${signal("restarting")}`);
  return EXIT.OK;
}

export default {
  name: "reboot", order: 82, usage: "sudo vyre reboot [--yes] [--dry-run]",
  summary: "restart this computer the planned way (FileVault Macs come back by themselves)",
  help: [
    "--dry-run   say what it would do and stop",
    "--yes       do not ask first (needed when there is no terminal to ask on)",
    "",
    "A Mac server with FileVault on restarts through `fdesetup authrestart`, so it returns to the",
    "desktop and Vyre starts without anyone at the login window. Other computers restart normally.",
  ].join("\n"),
  run: args => reboot(args),
};
