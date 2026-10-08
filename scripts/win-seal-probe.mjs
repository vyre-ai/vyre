#!/usr/bin/env node
// @ts-check
// Windows CI only (the Windows home walk): connect to the sealing service's pipe, send one health request, and say what happened.
//   node scripts/win-seal-probe.mjs <pipe>
// exit 0: the service answered (prints ANSWERED); 3: the connection was accepted and then closed with no answer (prints CLOSED: the service looked at who called and refused); 1: could not connect (prints DENIED <code>).
import net from "node:net";

const pipe = process.argv[2];
if (!pipe) { console.error("usage: win-seal-probe.mjs <pipe>"); process.exit(2); }
const c = net.createConnection(pipe);
const timer = setTimeout(() => { console.log("TIMEOUT"); c.destroy(); process.exit(1); }, 8000);
let buf = "";
c.once("connect", () => c.write(JSON.stringify({ id: 1, op: "health" }) + "\n"));
c.on("data", d => { buf += d; if (buf.includes("\n")) { clearTimeout(timer); let ok = false; try { ok = JSON.parse(buf.split("\n")[0]).ok === true; } catch { /* not JSON */ } console.log(ok ? "ANSWERED" : "ANSWERED_BAD"); c.destroy(); process.exit(ok ? 0 : 1); } });
c.once("close", () => { clearTimeout(timer); if (!buf) { console.log("CLOSED"); process.exit(3); } });
c.once("error", e => { clearTimeout(timer); console.log(`DENIED ${/** @type {any} */ (e).code}`); process.exit(1); });
