// @ts-check
// keys — where the Vault's master key lives, and nothing else.
//
// Three keystores, chosen in config (see docs/adr/0001-vault-crypto.md, decision 2):
//   - keychain: the macOS keychain. The key is written through `security -i` on stdin, because
//     anything on argv is visible to every user through `ps` for as long as the command runs.
//   - file: vault/key, 0600 in a 0700 folder. Load refuses a key file others can read, since a
//     key that leaked once has to be treated as leaked, and a silent chmod would hide that.
//   - passphrase: vault/key.wrapped, the key wrapped under scrypt of a passphrase. Without the
//     passphrase the vault is locked, and load says so by returning null rather than throwing.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { newMasterKey, wrapKey, unwrapKey } from "./crypto.js";

export const SERVICE = "vyre-vault";

/** @typedef {"keychain" | "file" | "passphrase"} Kind */

/** The keystore a fresh home gets: the keychain on macOS, a key file elsewhere. */
export function defaultKind(platform = process.platform) {
  return platform === "darwin" ? "keychain" : "file";
}

/** The keychain account for a vault folder, so two homes on one machine never collide. */
export function accountFor(dir) {
  return crypto.createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 16);
}

/** Quote one word for the `security -i` command line. */
const q = s => '"' + String(s).replace(/(["\\])/g, "\\$1") + '"';

/**
 * The argv and stdin for writing a key to the keychain. The key is only ever in stdin; this is
 * split out so a test can check that no argument carries it.
 * @param {{ account: string, hex: string, keychain?: string }} o
 */
export function keychainWriteCommand({ account, hex, keychain }) {
  const words = ["add-generic-password", "-U", "-s", q(SERVICE), "-a", q(account), "-w", q(hex)];
  if (keychain) words.push(q(keychain));
  return { argv: ["-i"], stdin: words.join(" ") + "\n" };
}

/**
 * Run `security` and collect its output.
 * @param {string[]} argv @param {string} [stdin]
 * @returns {Promise<{ code: number, out: string, err: string }>}
 */
function security(argv, stdin) {
  return new Promise((resolve, reject) => {
    const p = spawn("security", argv, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", d => { out += d; });
    p.stderr.on("data", d => { err += d; });
    p.on("error", reject);
    p.on("close", code => resolve({ code: code ?? -1, out, err }));
    p.stdin.end(stdin ?? "");
  });
}

const NOT_FOUND = 44;

/**
 * `security` again, a few times, when it fails for a reason other than "not found". The
 * keychain daemon answers "busy" or times out under load (many processes at once, a machine
 * just woken), and a vault that cannot read its key for one second should not fail a release.
 * Every command here is safe to repeat: read, add with -U, delete. `security -i` exits 0 when a
 * command inside it fails and reports the failure on stderr, so with stdin that counts too.
 * @param {string[]} argv @param {string} [stdin]
 */
async function securityRetry(argv, stdin) {
  const failed = r => r.code !== 0 ? r.code !== NOT_FOUND : stdin !== undefined && r.err.trim() !== "";
  let r = await security(argv, stdin);
  for (let i = 0; i < 3 && failed(r); i++) {
    await new Promise(res => setTimeout(res, 100 * 2 ** i));
    r = await security(argv, stdin);
  }
  return r;
}

/** @param {string} dir @param {string} [keychain] */
function keychainStore(dir, keychain) {
  const account = accountFor(dir);
  const tail = keychain ? [keychain] : [];
  const read = async () => {
    const r = await securityRetry(["find-generic-password", "-s", SERVICE, "-a", account, "-w", ...tail]);
    if (r.code === NOT_FOUND) return null;
    if (r.code !== 0) throw new Error(`could not read the vault key from the keychain: ${r.err.trim() || "exit " + r.code}`);
    const hex = r.out.trim();
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("the keychain entry for this vault is not a vault key");
    return Buffer.from(hex, "hex");
  };
  return {
    exists: async () => (await read()) !== null,
    /** @param {Buffer} mk */
    put: async mk => {
      const { argv, stdin } = keychainWriteCommand({ account, hex: mk.toString("hex"), keychain });
      const hex = mk.toString("hex");
      const r = await securityRetry(argv, stdin);
      // `security -i` exits 0 even when a command fails; the failure shows on stderr, which may
      // repeat the command it was given, key and all, so the key is cut out before it is shown.
      const err = r.err.split(hex).join("<key>").trim();
      if (r.code !== 0 || err) throw new Error(`could not write the vault key to the keychain: ${err || "exit " + r.code}`);
    },
    read,
    remove: async () => {
      const r = await securityRetry(["delete-generic-password", "-s", SERVICE, "-a", account, ...tail]);
      if (r.code !== 0 && r.code !== NOT_FOUND) throw new Error(`could not remove the vault key from the keychain: ${r.err.trim()}`);
    },
  };
}

/** Write a file only this user can read, failing if it already exists. */
function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
  fs.chmodSync(file, 0o600);
}

/** Read a private file, or null if missing; refuse one that group or others can read. */
function readPrivate(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { if (/** @type {any} */ (e).code === "ENOENT") return null; throw e; }
  if (st.mode & 0o077) {
    throw new Error(`${file} can be read by other users (mode ${(st.mode & 0o777).toString(8)}); treat the key as exposed, then chmod 600 it`);
  }
  return fs.readFileSync(file);
}

const rmFile = file => fs.rmSync(file, { force: true });

/**
 * The keystore for one vault folder.
 * @param {{ dir: string, kind: Kind, keychain?: string }} o
 */
export function keystore({ dir, kind, keychain }) {
  if (kind === "keychain") {
    const kc = keychainStore(dir, keychain);
    return {
      kind,
      exists: kc.exists,
      async create(_ = {}) {
        if (await kc.exists()) throw new Error("this vault already has a key in the keychain");
        const mk = newMasterKey();
        await kc.put(mk);
        return mk;
      },
      async load(_ = {}) { return kc.read(); },
      destroy: kc.remove,
    };
  }
  if (kind === "file") {
    const file = path.join(dir, "key");
    return {
      kind,
      async exists() { return fs.existsSync(file); },
      async create(_ = {}) {
        if (fs.existsSync(file)) throw new Error(`${file} already exists`);
        const mk = newMasterKey();
        writePrivate(file, mk.toString("hex") + "\n");
        return mk;
      },
      async load(_ = {}) {
        const raw = readPrivate(file);
        if (raw === null) return null;
        const hex = raw.toString("utf8").trim();
        if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`${file} is not a vault key`);
        return Buffer.from(hex, "hex");
      },
      async destroy() { rmFile(file); },
    };
  }
  if (kind === "passphrase") {
    const file = path.join(dir, "key.wrapped");
    return {
      kind,
      async exists() { return fs.existsSync(file); },
      /** @param {{ passphrase?: string }} [o] */
      async create({ passphrase } = {}) {
        if (!passphrase) throw new Error("a passphrase keystore needs a passphrase");
        if (fs.existsSync(file)) throw new Error(`${file} already exists`);
        const mk = newMasterKey();
        writePrivate(file, JSON.stringify(wrapKey(passphrase, mk)) + "\n");
        return mk;
      },
      /** @param {{ passphrase?: string }} [o] */
      async load({ passphrase } = {}) {
        const raw = readPrivate(file);
        if (raw === null || !passphrase) return null;
        return unwrapKey(passphrase, JSON.parse(raw.toString("utf8")));
      },
      async destroy() { rmFile(file); },
    };
  }
  throw new Error(`unknown vault keystore "${kind}"; use keychain, file or passphrase`);
}
