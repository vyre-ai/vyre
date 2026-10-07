#!/usr/bin/env node
// scripts/standin-phone.mjs: DEVELOPMENT-KIND TREES ONLY, TEST ONLY. A stand-in for the owner's phone in an automated walk: it lists the cards waiting in approvals.pending as a SECOND caller (a device cannot answer its own
// card), and answers each one yes (signed with the home's software key over the card's own `sign`, scripts/dev-sign-proof.mjs), no, or not at all. Nothing in the app or the daemon knows it exists: it is one more
// client of the box's socket, like the app walk's proxy.
//
//   node scripts/standin-phone.mjs --home <abs .vyre dir> [--answer yes|no|ignore] [--seconds 120] [--once]
//
//   --home     the home's .vyre folder (it holds vyred.sock, kernel/space.json and dev-owner-key.json from scripts/dev-enrol-software-key.mjs)
//   --answer   yes (default): sign and approve; no: say no (the asker is then held off for ten minutes); ignore: leave the card to run out (5 minutes)
//   --seconds  how long to keep listening (default 120); --once stops after the first card is answered
//   --caller   the x-vyre-caller label this stand-in uses (default local; the asking browser must use another one)
// Prints one JSON line per card: { card, op, answer, result }. Exit 0 when it answered or ignored what it saw, 2 when the build is release-kind or the home is not enrolled, 3 when no card appeared.
// The home must run with VYRE_SEAL_DEV=1 and VYRE_SEAL_SOFTWARE=1 and NOT with VYRE_KERNEL_FILE_KEY (the software key is checked by the sealing process).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { devSwitch } from "../kernel/seal/appattest.js";

const argv = process.argv.slice(2);
const take = (/** @type {string} */ f, /** @type {string} */ d = "") => { const i = argv.indexOf(f); return i < 0 ? d : argv[i + 1]; };
const die = (/** @type {number} */ c, /** @type {string} */ m) => { process.stderr.write(`standin-phone: ${m}\n`); process.exit(c); };
if (!devSwitch("1")) die(2, "this is a release-kind build: a stand-in phone is refused here");
const home = take("--home") || process.env.VYRE_HOME || "";
if (!path.isAbsolute(home)) die(64, "--home must be an absolute path to the home's .vyre folder");
if (!fs.existsSync(path.join(home, "dev-owner-key.json"))) die(2, "no dev-owner-key.json in this home: run scripts/dev-enrol-software-key.mjs first (daemon stopped)");
const answer = take("--answer", "yes");
if (!["yes", "no", "ignore"].includes(answer)) die(64, "--answer is yes, no or ignore");
const seconds = Number(take("--seconds", "120"));
const caller = take("--caller", "local");
const once = argv.includes("--once");
const sock = path.join(home, "vyred.sock");
const here = path.dirname(fileURLToPath(import.meta.url));

/** One tool call over the box's socket. @param {string} tool @param {any} input @param {Record<string, string>} [headers] */
function call(tool, input = {}, headers = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify(input);
    const r = http.request({ socketPath: sock, path: `/v1/tools/${tool}`, method: "POST", headers: { host: "localhost", "x-vyre-caller": caller, "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers } }, (x) => {
      let s = ""; x.on("data", (c) => (s += c)); x.on("end", () => { try { resolve(JSON.parse(s)); } catch { resolve({ error: { code: "bad_reply", message: s.slice(0, 120) } }); } });
    });
    r.on("error", (e) => resolve({ error: { code: "unreachable", message: String(e.message) } }));
    r.end(body);
  });
}

/** The proof for a card: its own `sign` (op, space, fields), signed by the home's software key. */
function proofHeader(/** @type {{ op: string, space: string, fields: any }} */ sign) {
  const p = spawnSync(process.execPath, [path.join(here, "dev-sign-proof.mjs"), "--home", home, "--space", sign.space, "--op", sign.op, "--fields", JSON.stringify(sign.fields), "--header"], { encoding: "utf8" });
  if (p.status !== 0) throw new Error(p.stderr.trim() || "dev-sign-proof failed");
  return p.stdout.trim();
}

// The answer needs the owner's signed-in session (a "no" counts only from one): the dev tool signin.dev makes the stand-in's, marked as such.
const si = await call("signin.dev", { node: `standin-phone-${process.pid}`, label: "stand-in phone" });
if (si.error) die(2, `signin.dev refused: ${si.error.code}: ${String(si.error.message).slice(0, 160)} (the home needs its dev stand-in file)`);
const cookie = { cookie: `__Host-vyre_person=${si.data.token}` };

const seen = new Set();
let answered = 0;
const until = Date.now() + seconds * 1000;
while (Date.now() < until) {
  const list = await call("approvals.pending");
  for (const c of list.data?.approvals ?? []) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    let result;
    if (answer === "ignore") result = { left: true };
    else if (answer === "no") result = await call("approvals.answer", { id: c.id, approve: false }, cookie);
    else {
      try { result = await call("approvals.answer", { id: c.id, approve: true }, { ...cookie, "x-vyre-kernel-proof": proofHeader(c.sign ?? { op: c.op, space: c.space, fields: c.fields }) }); }
      catch (e) { result = { error: { code: "no_signature", message: String(/** @type {Error} */ (e).message) } }; }
    }
    process.stdout.write(JSON.stringify({ card: c.id, op: c.request?.op ?? c.op, line: c.line, answer, result: result.data ?? result.error ?? result }) + "\n");
    answered++;
    if (once) process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 400));
}
process.exit(answered ? 0 : 3);
