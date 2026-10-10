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
import { dialogsAllowed } from "../config/dialogs.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { newMasterKey, wrapKey, unwrapKey, fromHex } from "./crypto.js";
import { enclaveCall as helperCall } from "./touchid.js";

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
 * Run `security` and collect its output. Under heavy concurrent `security` load (many
 * processes hammering the keychain daemon at once) the child can exit before this finishes
 * writing its stdin; that is a plain EPIPE on `p.stdin`, not a crash, so it is caught here and
 * turned into a failing result `securityRetry` can retry, instead of an uncaught rejection that
 * skips the retry loop entirely.
 * @param {string[]} argv @param {string} [stdin]
 * @returns {Promise<{ code: number, out: string, err: string }>}
 */
function security(argv, stdin) {
  return new Promise((resolve, reject) => {
    const p = spawn("security", argv, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", stdinFailed = false;
    p.stdout.on("data", d => { out += d; });
    p.stderr.on("data", d => { err += d; });
    p.stdin.on("error", () => { stdinFailed = true; });
    p.on("error", reject);
    p.on("close", code => resolve({ code: stdinFailed ? -1 : (code ?? -1), out, err }));
    try { p.stdin.end(stdin ?? ""); } catch { stdinFailed = true; }
  });
}

const NOT_FOUND = 44;

/**
 * `security` again, a few times, when it fails for a reason other than "not found". The
 * keychain daemon answers "busy" or times out under load (many processes at once, a machine
 * just woken), and a vault that cannot read its key for one second should not fail a release.
 * Every command here is safe to repeat: read, add with -U, delete. `security -i` exits 0 when a
 * command inside it fails and reports the failure on stderr, so with stdin that counts too.
 * A spawn-level failure (ENOENT, or a stdin EPIPE from a child that exited early under load)
 * rejects instead of resolving; that is retried the same as a bad exit code.
 * @param {string[]} argv @param {string} [stdin]
 */
async function securityRetry(argv, stdin) {
  const failed = r => r.code !== 0 ? r.code !== NOT_FOUND : stdin !== undefined && r.err.trim() !== "";
  const run = () => security(argv, stdin).catch(e => ({ code: -1, out: "", err: String(e && e.message || e) }));
  let r = await run();
  for (let i = 0; i < 3 && failed(r); i++) {
    await new Promise(res => setTimeout(res, 100 * 2 ** i));
    r = await run();
  }
  return r;
}

/**
 * One keychain entry through /usr/bin/security: the path before the keychain helper, kept to
 * read (once) and remove items that path wrote, and for a Mac where the helper cannot be built.
 * @param {string} account @param {string} [keychain] @param {(text: string) => Buffer} decode
 */
function legacyStore(account, keychain, decode) {
  const tail = keychain ? [keychain] : [];
  // The login keychain can ask for the user's password; a test keychain file (keychain set) cannot.
  const noDialog = () => { if (!keychain && !dialogsAllowed()) throw Object.assign(new Error("the login keychain is off under tests: use a test keychain file"), { code: "no_dialog" }); };
  const read = async () => {
    noDialog();
    const r = await securityRetry(["find-generic-password", "-s", SERVICE, "-a", account, "-w", ...tail]);
    if (r.code === NOT_FOUND) return null;
    if (r.code !== 0) throw new Error(`could not read the vault key from the keychain: ${r.err.trim() || "exit " + r.code}`);
    return decode(r.out.trim());
  };
  return {
    read,
    /** @param {string} text */
    put: async text => {
      noDialog();
      const { argv, stdin } = keychainWriteCommand({ account, hex: text, keychain });
      const r = await securityRetry(argv, stdin);
      // `security -i` exits 0 even when a command fails; the failure shows on stderr, which may
      // repeat the command it was given, key and all, so the key is cut out before it is shown.
      const err = r.err.split(text).join("<key>").trim();
      if (r.code !== 0 || err) throw new Error(`could not write the vault key to the keychain: ${err || "exit " + r.code}`);
    },
    remove: async () => {
      noDialog();
      const r = await securityRetry(["delete-generic-password", "-s", SERVICE, "-a", account, ...tail]);
      if (r.code !== 0 && r.code !== NOT_FOUND) throw new Error(`could not remove the vault key from the keychain: ${r.err.trim()}`);
    },
  };
}

/**
 * One keychain entry for a vault folder. `suffix` picks a second entry under the same service
 * (the Secret Key lives apart from the device key), and `decode` checks and decodes what was read.
 *
 * With `helper` (mac/keychain.swift), items are written through that hash-checked helper with an
 * access list naming only it, so `security find-generic-password -w` run by anything else gets a
 * system prompt, not the key (ADR 0006 finding 1). Every call sends `noUI: true`: nothing here
 * can raise a dialog. Each item's comment names the helper build that wrote it
 * (`vyre-helper:<binary hash>`), read with `info`, which never touches the secret:
 *   - this build: read it.
 *   - no comment: `security -i` wrote it and is on its access list, so `security` reads it
 *     without a prompt; it is then written again through the helper and the old one deleted.
 *   - another build still in the helpers folder (checked by its hash): that binary reads it, and
 *     it is moved to this build the same way.
 *   - another build that is gone: refuse, and name `vyre vault migrate-key`, the one path a
 *     person runs on purpose, which may ask them to allow access.
 * @param {string} dir @param {string} [keychain] @param {string} [suffix]
 * @param {(text: string) => Buffer} [decode] @param {import("./mac/helper.js").Helper|null} [helper]
 */
function keychainStore(dir, keychain, suffix = "", decode = hexKey("the keychain entry for this vault is not a vault key"), helper = null, login = false) {
  // The login keychain (no keychain file) only when the caller says this home may use it.
  if (!keychain && !login) {
    const off = async () => { throw Object.assign(new Error("the login keychain is off for this home: ask the owner to allow it"), { code: "no_dialog" }); };
    return { exists: off, put: off, read: off, remove: off, migrate: off };
  }
  const account = accountFor(dir) + suffix;
  const legacy = legacyStore(account, keychain, decode);
  if (!helper || !helper.usable()) return { ...legacy, exists: async () => (await legacy.read()) !== null, migrate: async () => ({ moved: false }) };
  const q = { service: SERVICE, account, ...(keychain ? { keychain } : {}) };
  const me = async () => helper.ensure();
  const call = async (req, noUI = true) => helperCall(helper, { ...q, ...req, noUI, ...(req.op === "write" ? { helper: (await me()).hash } : {}) });
  /** A build of the helper named by its binary hash, if it is still in the private folder. */
  const buildFor = async hash => {
    const d = path.dirname((await me()).path);
    for (const n of fs.readdirSync(d)) {
      if (!/^vyre-vault-keychain-[0-9a-f]{16}$/.test(n)) continue;
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      if (!st.isFile() || (st.mode & 0o022)) continue;
      if (crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") === hash) return p;
    }
    return null;
  };
  const byBinary = (bin, req) => helperCall({ spawn: async () => spawn(bin, [], { stdio: "pipe" }) }, { ...q, ...req, noUI: true });
  const move = async text => {
    const w = await call({ op: "write", secret: text });
    if (!w.ok) throw new Error(`could not write the vault key through the keychain helper (${w.status || w.code})`);
    const back = await call({ op: "read" });
    if (!back.ok || back.secret !== text) throw new Error("the vault key did not read back through the keychain helper");
  };
  const textOf = buf => (suffix ? buf.toString("utf8") : buf.toString("hex"));
  const read = async () => {
    const info = await call({ op: "info" });
    if (!info.ok) throw new Error(`could not look up the vault key in the keychain (${info.status || info.code})`);
    if (!info.found) return null;
    const comment = typeof info.comment === "string" ? info.comment : "";
    const mine = `vyre-helper:${(await me()).hash}`;
    if (comment === mine) {
      const r = await call({ op: "read" });
      if (!r.ok) throw new Error(`could not read the vault key from the keychain (${r.status || r.code})`);
      return r.secret == null ? null : decode(String(r.secret));
    }
    if (!comment.startsWith("vyre-helper:")) {
      const old = await legacy.read();
      if (!old) return null;
      await legacy.remove();
      await move(textOf(old));
      return old;
    }
    const bin = await buildFor(comment.slice("vyre-helper:".length));
    if (!bin) throw new Error("the keychain item was written by a helper build that is gone; run vyre vault migrate-key");
    const o = await byBinary(bin, { op: "read" });
    if (!o.ok || o.secret == null) throw new Error(`the older keychain helper could not read the vault key (${o.status || o.code}); run vyre vault migrate-key`);
    const text = String(o.secret);
    await byBinary(bin, { op: "delete" });
    await move(text);
    return decode(text);
  };
  return {
    exists: async () => (await read()) !== null,
    /** @param {string} text */
    put: async text => {
      const w = await call({ op: "write", secret: text });
      if (!w.ok) throw new Error(`could not write the vault key to the keychain (${w.status || w.code})`);
    },
    read,
    remove: async () => {
      const r = await call({ op: "delete" });
      if (!r.ok) throw new Error(`could not remove the vault key from the keychain (${r.status || r.code})`);
    },
    /**
     * The person-run path (`vyre vault migrate-key`): read through this build with interaction
     * on, so macOS may ask the person to allow it, then write it again under this build.
     */
    migrate: async () => {
      const r = await call({ op: "read" }, false);
      if (!r.ok) throw new Error(`the keychain item could not be read (${r.status || r.code}); allow access when macOS asks, or restore from a backup`);
      if (r.secret == null) return { moved: false };
      await move(String(r.secret));
      return { moved: true };
    },
  };
}

/** A decoder for a 64-hex-character key, into a buffer the caller zeroes. */
function hexKey(message) {
  return text => { try { return fromHex(text); } catch { throw new Error(message); } };
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
 * @param {{ dir: string, kind: Kind, keychain?: string, helper?: import("./mac/helper.js").Helper|null, login?: boolean }} o
 *   helper: the keychain helper (mac/keychain.swift); without one the keychain is written by `security`.
 *   login: this home may use the login keychain. Without it and without a keychain file, every
 *   keychain call refuses before anything runs.
 */
export function keystore({ dir, kind, keychain, helper = null, login = false }) {
  if (kind === "keychain") {
    const kc = keychainStore(dir, keychain, "", undefined, helper, login);
    return {
      kind,
      exists: kc.exists,
      async create(_ = {}) {
        if (await kc.exists()) throw new Error("this vault already has a key in the keychain");
        const mk = newMasterKey();
        await kc.put(mk.toString("hex"));
        return mk;
      },
      async load(_ = {}) { return kc.read(); },
      destroy: kc.remove,
      migrate: kc.migrate,
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
        try { return hexKey(`${file} is not a vault key`)(raw.toString("utf8").trim()); } finally { raw.fill(0); }
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

/**
 * Where the account's Secret Key lives on this device (ADR 0006 decision 1): the keychain, as a
 * second generic password under a distinct account, or `secret-key`, 0600, beside the key file.
 * The passphrase keystore uses the file too: the Secret Key alone opens nothing.
 * @param {{ dir: string, kind: Kind, keychain?: string, helper?: any, login?: boolean }} o
 */
export function secretKeyStore({ dir, kind, keychain, helper = null, login = false }) {
  const text = s => { if (!/^V2-[A-Z2-7-]{20,60}$/.test(s)) throw new Error("the stored Secret Key is not one"); return Buffer.from(s, "utf8"); };
  if (kind === "keychain") {
    const kc = keychainStore(dir, keychain, ":sk", text, helper, login);
    return {
      /** @param {string} formatted */
      async put(formatted) { await kc.put(formatted); },
      /** @returns {Promise<string|null>} */
      async read() { const b = await kc.read(); if (!b) return null; const s = b.toString("utf8"); b.fill(0); return s; },
      remove: kc.remove,
      migrate: kc.migrate,
    };
  }
  const file = path.join(dir, "secret-key");
  return {
    /** @param {string} formatted */
    async put(formatted) { writePrivate(file, formatted + "\n"); },
    async read() {
      const raw = readPrivate(file);
      if (raw === null) return null;
      try { return text(raw.toString("utf8").trim()).toString("utf8"); } finally { raw.fill(0); }
    },
    async remove() { rmFile(file); },
  };
}
