#!/usr/bin/env node
// @ts-check
// A stand-in for `tini -s -- <command> [args]`, for tests: runs the command with this process's
// stdio and exits with its code. What matters to the tests is that it sits between the driver
// and Claude Code, as tini does on the box.
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const at = argv.indexOf("--");
const [cmd, ...args] = at >= 0 ? argv.slice(at + 1) : argv;
const c = spawn(cmd, args, { stdio: "inherit" });
for (const s of /** @type {NodeJS.Signals[]} */ (["SIGTERM", "SIGINT", "SIGHUP"])) process.on(s, () => { try { c.kill(s); } catch {} });
c.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
