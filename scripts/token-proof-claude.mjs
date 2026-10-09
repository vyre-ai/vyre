#!/usr/bin/env node
// @ts-check
// token-proof-claude (R031-00n): a pass-through in front of the real `claude`, set as VYRE_CLAUDE_BIN for the token proof's paid round. Vyre starts it as it starts any session; it runs the real
// claude (TOKEN_PROOF_REAL_CLAUDE) with the same arguments, standard input and extra descriptors, hands every output line on unchanged, and appends a copy to the file TOKEN_PROOF_TEE names, so the
// proof can read the tokens, cost and tool calls Claude Code itself reported without touching how Vyre drives the session. It holds no credential and prints none.
import fs from "node:fs";
import { spawn } from "node:child_process";

// One copy file per claude process (`<TOKEN_PROOF_TEE>.<pid>.part`), never one shared file: a helper session Vyre starts beside the thread under test (memory, a teammate), or a second proof running on the
// same box, would otherwise interleave its lines with the run's, and the run's tokens, cost and answer would be read from several sessions at once.
const real = process.env.TOKEN_PROOF_REAL_CLAUDE || "claude", tee = process.env.TOKEN_PROOF_TEE ? `${process.env.TOKEN_PROOF_TEE}.${process.pid}.part` : "";
// stdin, stdout, stderr, and descriptor 3 as given (an API key comes on a descriptor, never in the environment)
const child = spawn(real, process.argv.slice(2), { stdio: ["pipe", "pipe", "inherit", "inherit"], env: process.env });
process.stdin.pipe(/** @type {any} */ (child.stdin));
child.stdout.on("data", (/** @type {Buffer} */ b) => { process.stdout.write(b); if (tee) { try { fs.appendFileSync(tee, b); } catch { /* the copy is best effort */ } } });
for (const sig of /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"])) process.on(sig, () => child.kill(sig));
child.on("error", (e) => { process.stderr.write(`token-proof-claude: ${e.message}\n`); process.exit(127); });
child.on("close", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
