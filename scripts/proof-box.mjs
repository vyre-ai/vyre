#!/usr/bin/env node
// A vyred for the real-account runs on the TEST BOX only (the test box, never a person's Mac): the same daemon as `vyre daemon`, but its presence verifier says
// yes to everything, (and it trusts the ssh login it runs under, the daemon's own test seam, presence.trustsServer), so a proof can answer an ask (threads.answer) without a person at a terminal. The throwaway home holds only the proof's own accounts.
// Refuses to run anywhere the daemon host guard refuses. Usage: VYRE_HOME=/srv/vyre-test/sessions-real node scripts/proof-box.mjs
import { start } from "../core/daemon/index.js";
import { execFile } from "node:child_process";
import { present } from "../test/helpers.js";

const root = process.env.VYRE_HOME;
if (!root || !/^\/srv\/vyre-test\//.test(root)) { console.error("proof-box: VYRE_HOME must be a throwaway home under /srv/vyre-test/"); process.exit(2); }
// Anything else the daemon asks the verifier for answers "nothing" (no keys, no logins, no pin): the proof has no person to ask.
const who = () => new Promise(resolve => execFile("/usr/bin/who", [], { timeout: 5000 }, (err, out) => resolve(err ? [] : String(out).split("\n").map(l => l.trim().split(/\s+/)[1]).filter(Boolean))));
const lists = new Set(["methods", "keys", "list", "logins"]);
const verifier = new Proxy(present, { get: (t, k) => (k === "who" ? who : k === "trustsServer" ? () => true : k in t ? t[k] : (k === "then" ? undefined : lists.has(String(k)) ? async () => [] : () => null)) });
const d = await start({ root, presence: verifier, log: m => console.log(String(m)) });
console.log("proof-box up at", root);
const stop = async () => { try { await d.stop(); } finally { process.exit(0); } };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
