// @ts-check
// The Mac's Secure Enclave key (se.swift), for proving the person to the box (ADR 0032 part 2c).
// Built on first use into a private folder, as the Touch ID helper is, and its hash is checked
// before every run: anything running as this user could swap the file for one that signs with a
// key of its own. Creating a key asks nothing; every signature asks the person (Touch ID), so it
// never runs under tests unless VYRE_TEST_DIALOGS=1 (core/config/dialogs.js).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dialogsAllowed } from "../../config/dialogs.js";

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "se.swift");
const SWIFTC = "/usr/bin/swiftc";
const sha256 = (/** @type {Buffer} */ b) => crypto.createHash("sha256").update(b).digest("hex");
const uid = () => (typeof process.getuid === "function" ? process.getuid() : -1);

/** @type {Promise<{ path: string, hash: string }> | null} */
let built = null;

function privateDir() {
  const dir = path.join(os.tmpdir(), `vyre-presence-${uid() < 0 ? "user" : uid()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || (uid() >= 0 && st.uid !== uid()) || (st.mode & 0o077) !== 0) throw new Error(`${dir} is not a private folder owned by this user`);
  return dir;
}

/** @param {string} file @param {string[]} args @param {number} ms @param {string} [stdin] */
function run(file, args, ms, stdin) {
  return new Promise(resolve => {
    const child = execFile(file, args, { timeout: ms, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }, (err, stdout) => {
      const e = /** @type {any} */ (err);
      resolve({ code: err ? (typeof e.code === "number" ? e.code : null) : 0, out: String(stdout || "").trim() });
    });
    child.stdin?.end(stdin || "");
  });
}

async function build() {
  if (process.platform !== "darwin") throw new Error("the Secure Enclave needs macOS");
  if (!fs.existsSync(SWIFTC)) throw new Error(`${SWIFTC} not found`);
  const source = fs.readFileSync(SOURCE);
  const target = path.join(privateDir(), `vyre-se-${sha256(source).slice(0, 16)}`);
  if (!fs.existsSync(target)) {
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
    const r = /** @type {any} */ (await run(SWIFTC, ["-O", "-o", tmp, SOURCE], 300_000));
    if (r.code !== 0) { fs.rmSync(tmp, { force: true }); throw new Error(`swiftc failed (${r.code})`); }
    fs.renameSync(tmp, target);
  }
  const st = fs.lstatSync(target);
  if (!st.isFile() || (uid() >= 0 && st.uid !== uid()) || (st.mode & 0o022) !== 0) throw new Error(`${target} is not a private file owned by this user`);
  return { path: target, hash: sha256(fs.readFileSync(target)) };
}

async function helper() {
  if (!built) { built = build(); built.catch(() => { built = null; }); }
  const h = await built;
  if (sha256(fs.readFileSync(h.path)) !== h.hash) { built = null; throw new Error("the Secure Enclave helper changed on disk; refusing to run it"); }
  return h.path;
}

/**
 * A new key in the Secure Enclave. Asks nothing.
 * @returns {Promise<{ handle: string, spki: string }>} handle: the opaque, this-Mac-only key handle; spki: base64url SPKI DER
 */
export async function create() {
  const r = /** @type {any} */ (await run(await helper(), ["create"], 30_000));
  if (r.code !== 0) throw new Error("the Secure Enclave is not available on this Mac");
  const o = JSON.parse(r.out);
  if (typeof o.handle !== "string" || typeof o.spki !== "string") throw new Error("the Secure Enclave helper answered something else");
  return o;
}

/**
 * Sign a message with the key, which asks the person (Touch ID, Apple Watch or the password).
 * @param {string} handle @param {Buffer} message @param {string} reason
 * @returns {Promise<string>} base64url DER ECDSA signature
 */
export async function sign(handle, message, reason) {
  if (!dialogsAllowed()) throw Object.assign(new Error("Touch ID is off here (VYRE_NO_DIALOGS or a test)"), { code: "no_dialog" });
  const r = /** @type {any} */ (await run(await helper(), ["sign", reason, "60"], 70_000, JSON.stringify({ handle, message: message.toString("base64") })));
  if (r.code !== 0) throw Object.assign(new Error("you did not confirm it on this Mac"), { code: "presence_required" });
  return r.out;
}
