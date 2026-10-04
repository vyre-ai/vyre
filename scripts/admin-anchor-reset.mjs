#!/usr/bin/env node
// scripts/admin-anchor-reset.mjs: what `sudo vyre admin anchor-reset` runs, as the home's user, with the daemon already stopped (launch's wrapper stops it and runs this from a one-off container
// of the image). A restore from a backup puts the database behind the anchor the sealing process keeps outside it, and a packaged kernel then refuses to start (BL-2, AN-1). The way out is
// the owner's own `anchor.reset`: the sealing process forgets the anchor after it checks the owner's presence proof for that exact act, and the next checkpoint writes a fresh one.
// This starts the sealing process only (never the kernel or the daemon), and leaves one sealed `anchor.reset` event in the log naming the person (BL2-1), so the reset is on record.
//
//   node scripts/admin-anchor-reset.mjs --home <dir> [--wait <seconds, default 300>] [--seal-dir <dir>]
// It starts the sealing process, writes ONE line of JSON to stdout, `{ "request": { op, space, person, fields, payload_hash, chain_hash, chain } }`, and waits for ONE line of JSON on stdin:
// the owner's presence proof for that request (their device signs `payload_hash` for `chain_hash`, the same proof shape every presence act uses: kernel/seal/wire.js `payloadHash`, `chainCtx`).
// The proof must be made AFTER the request line is printed: the sealing process takes no proof issued before it started (the used-proof list is in memory), and a proof is single use and
// lives under a minute. launch's wrapper carries the request to the owner's phone (the way the rollback ask does) and writes the signed proof back on stdin.
//   node scripts/admin-anchor-reset.mjs --home <dir> --request      print the request only (nothing is started or changed), for a signer that is not live
// Exit codes: 0 reset, 2 refused (stderr `refused: <code>: <reason>`; nothing changed), 64 bad arguments, 1 anything else.
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { startSealer } from "../kernel/seal/client.js";
import { chainCtx, payloadHash } from "../kernel/seal/wire.js";
import { createSqliteEventLog } from "../kernel/store/sqlite-log.js";
import { createChainBuilder } from "../kernel/core/chain.js";
import { createKernelSeal } from "../kernel/core/seal.js";

const argv = process.argv.slice(2);
function usage(/** @type {string} */ why) { process.stderr.write(`${why}\nusage: admin-anchor-reset.mjs --home <dir> (--request | [--wait <seconds>]) [--seal-dir <dir>]\n`); process.exit(64); }
const take = (/** @type {string} */ flag) => { const i = argv.indexOf(flag); if (i === -1) return undefined; if (i + 1 >= argv.length) usage(`${flag} needs a value`); return argv[i + 1]; };
for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith("--")) { if (!["--home", "--request", "--wait", "--seal-dir"].includes(a)) usage(`unknown option ${a}`); if (a !== "--request") i++; } }

const home = take("--home") || process.env.VYRE_HOME;
if (!home || !path.isAbsolute(home)) usage("--home must be an absolute path to the Vyre home");
const wantRequest = argv.includes("--request"), waitS = Number(take("--wait") ?? 300);
if (wantRequest && take("--wait") !== undefined) usage("--request takes no --wait");
if (!(waitS >= 1 && waitS <= 3600)) usage("--wait is 1 to 3600 seconds");
const sealDir = take("--seal-dir") || path.join(home, "kernel", "seal");
if (!path.isAbsolute(sealDir)) usage("--seal-dir must be absolute");

class Refused extends Error { /** @param {string} code @param {string} why */ constructor(code, why) { super(why); this.code = code; } }

/** The Space and its owner, as the home wrote them (kernel/home.js homeIdentity); read only, never made here. */
function identity() {
  let id;
  try { id = JSON.parse(fs.readFileSync(path.join(home, "kernel", "space.json"), "utf8")); } catch { id = null; }
  if (!id || !/^spc_[a-z2-7]{12}$/.test(id.space) || !/^per_[a-z2-7]{26}$/.test(id.owner)) throw new Refused("no_home", "this folder holds no Vyre home (no kernel/space.json)");
  return /** @type {{ space: string, owner: string }} */ (id);
}
/** The owner's own chain at the command line, the shape chainCtx hashes: one person hop (the home's owner) on the cli surface. @param {string} space @param {string} owner */
const ownerChain = (space, owner) => ({ space, hops: [{ actor: { kind: "person", id: owner, space }, via: { surface: "cli" } }] });

try {
  const { space, owner } = identity();
  const chain = ownerChain(space, owner);
  if (wantRequest) {
    const ctx = chainCtx(/** @type {any} */ (chain));
    process.stdout.write(JSON.stringify({ op: "anchor.reset", space, person: owner, fields: {}, payload_hash: payloadHash("anchor.reset", space, {}), chain_hash: ctx.chain_hash, chain }, null, 2) + "\n");
    process.exit(0);
  }
  const dbFile = path.join(home, "vyre.db");
  if (!fs.existsSync(dbFile)) throw new Refused("no_home", "this home has no database to record the reset in");
  const dev = process.env.VYRE_SEAL_DEV === "1";
  const sealer = startSealer({ dir: sealDir, dev, ...(dev && process.env.VYRE_SEAL_UNATTESTED === "1" ? { unattested: true } : {}), ...(process.env.VYRE_SEAL_PROFILE ? { profile: process.env.VYRE_SEAL_PROFILE } : {}) });
  try {
    await sealer.health?.();
    if (typeof sealer.anchor?.reset !== "function") throw new Refused("unsupported", "this sealing process has no anchor.reset");
    const ctx = chainCtx(/** @type {any} */ (chain));
    process.stdout.write(JSON.stringify({ request: { op: "anchor.reset", space, person: owner, fields: {}, payload_hash: payloadHash("anchor.reset", space, {}), chain_hash: ctx.chain_hash, chain } }) + "\n");
    /** @type {NodeJS.Timeout | undefined} */ let timer;
    const first = (async () => { for await (const l of createInterface({ input: process.stdin })) return /** @type {string} */ (l); return null; })();
    const line = await Promise.race([first, new Promise(res => { timer = setTimeout(() => res(undefined), waitS * 1000); })]);
    clearTimeout(timer);
    if (line === undefined) throw new Refused("timeout", `no proof arrived within ${waitS} seconds`);
    if (line === null) throw new Refused("no_proof", "no proof was given");
    let proof;
    try { proof = JSON.parse(/** @type {string} */ (line)); } catch { throw new Refused("bad_proof", "the proof is not readable JSON"); }
    if (!proof || typeof proof !== "object" || Array.isArray(proof)) throw new Refused("bad_proof", "the proof is not a presence proof");
    try { await sealer.anchor.reset({ chain: /** @type {any} */ (chain), proof }); }
    catch (e) { const c = /** @type {any} */ (e).code || "failed"; throw new Refused(c === "sealer_down" || c === "timeout" ? c : c, c === "needs_presence" ? "the proof does not stand for this act (wrong, used, expired, or not the owner's)" : `the sealing process refused: ${c}`); }
    // One sealed record that the anchor was reset, by whom, appended in the kernel's own chain-of-events so it cannot be forged by a file edit (BL2-1).
    const db = new DatabaseSync(dbFile);
    try {
      const log = createSqliteEventLog({ db, space });
      const chains = createChainBuilder({ space, owner, owner_uid: process.getuid ? process.getuid() : 0, seal: createKernelSeal({ sealer }), clock: Date.now, is_person: () => true });
      log.append(chains.fromFacts({ kind: "module", module: "admin", first_party: true }), { type: "anchor.reset", sv: 1, subject: `vyre://${space}/audit/anchor`, data: { by: owner, at: Date.now() }, vis: "owner", red: "internal" });
    } finally { db.close(); }
    process.stdout.write(JSON.stringify({ reset: true, space, by: owner }) + "\n");
  } finally { await sealer.close?.().catch(() => {}); }
  process.exit(0);
} catch (e) {
  const err = /** @type {any} */ (e);
  process.stderr.write(`refused: ${err.code || "failed"}: ${err.message}\n`);
  process.exit(err.code ? 2 : 1);
}
