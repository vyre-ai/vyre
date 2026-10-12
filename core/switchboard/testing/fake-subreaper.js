#!/usr/bin/env node
// A stand-in for tini as the Switchboard wraps a session in it (`<subreaper> -s -- <command> <args...>`): it stays as the parent, runs the command with this process's stdin, stdout and stderr, forwards the
// signals it is sent, and exits with the command's status. The wrapped program is a CHILD of this process, as it is under tini, so a test with it does not depend on the box having tini installed.
import { spawn } from "node:child_process";
const at = process.argv.indexOf("--");
const argv = at >= 0 ? process.argv.slice(at + 1) : process.argv.slice(2);
const child = spawn(argv[0], argv.slice(1), { stdio: "inherit" });
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { try { child.kill(sig); } catch { /* gone */ } });
child.on("error", () => process.exit(127));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 0)));
