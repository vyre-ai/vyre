// @ts-check
// identity: the username, the master password and the one-screen recovery key (ADR 0054). The chain itself stays spaces.identity.create.
// This module wraps the keys that file already holds. A model caller cannot supply the password or the recovery key.

import fs from "node:fs";
import path from "node:path";
import { isPerson } from "../../lib/caller.js";
import { modelSuppliedSecret, SECRET_REFUSED } from "../../lib/master-secret.js";
import { newRecoveryCode } from "../../kernel/identity/code.js";
import * as M from "../../kernel/identity/master.js";
import { checkUsername, publicCard } from "../../kernel/identity/username.js";

const MIGRATIONS = [
  `CREATE TABLE identity_master (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state TEXT NOT NULL,
    username TEXT,
    at INTEGER NOT NULL
  )`,
];

const obj = (properties, required = []) => ({ type: "object", properties, required });
const str = { type: "string" };
const refuse = (message, code) => Object.assign(new Error(message), { code });

/** Cheap Argon2id for tests. Production uses MASTER_KDF. */
function kdf() {
  return process.env.VYRE_TEST_MASTER_KDF === "cheap" ? M.TEST_KDF : M.MASTER_KDF;
}

/** @param {any} meta @param {any} input */
function refuseModel(meta, input) {
  if (modelSuppliedSecret(meta && meta.caller, input, meta && meta.origin)) throw refuse(SECRET_REFUSED, "secret_refused");
}

/** @param {any} meta @param {any} body */
function forCaller(meta, body) {
  if (isPerson(meta && meta.origin) || isPerson(meta && meta.caller)) return body;
  const rest = { ...body };
  delete rest.recoveryKey;
  return { ...rest, note: "The recovery key is shown on your device." };
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const root = ctx.paths.root;
    const idFile = M.identityPath(root);
    try {
      const legacy = JSON.parse(fs.readFileSync(idFile, "utf8"));
      if (legacy && legacy.privateKey && !fs.existsSync(M.masterPath(root))) {
        ctx.store.db.prepare("INSERT OR IGNORE INTO identity_master (id, state, username, at) VALUES (1, 'pending', ?, ?)").run(legacy.name || null, Date.now());
      }
    } catch { /* no identity file yet */ }

    const tool = (name, description, input, run) => ctx.tool(name, { description, input, run });

    tool("identity.create", "Make your username. You enter the master password on your device. The recovery key is shown once there.",
      obj({ username: str, code: str, password: str, deviceLabel: str }, ["username", "password"]),
      async (input, meta) => {
        refuseModel(meta, input);
        if (input.password == null || input.password === "") throw refuse("Enter your master password on this device.", "person_enters");
        const name = checkUsername(input.username);
        const password = M.checkPassword(input.password);
        const r = await ctx.call("spaces.identity.create", { name, password: "", ...(input.code ? { code: input.code } : {}), ...(input.deviceLabel ? { deviceLabel: input.deviceLabel } : {}) });
        if (!r || r.error) throw refuse((r && r.error && r.error.message) || "The name could not be claimed. Try again.", (r && r.error && r.error.code) || "failed");
        const recoveryKey = r.data && r.data.recoveryCode;
        if (!recoveryKey) throw refuse("The identity did not return a recovery key. Try again.", "failed");
        const legacy = JSON.parse(fs.readFileSync(idFile, "utf8"));
        const vaultKey = M.readVaultKeyFile(path.join(root, "vault", "key"));
        M.createMaster({
          root, username: name, id: legacy.id, password, recoveryCode: recoveryKey,
          privateKeyB64: legacy.privateKey, agreePrivateB64: legacy.agreePrivate || null,
          vaultKey, kdf: kdf(), identityFile: idFile,
        });
        ctx.store.db.prepare("INSERT INTO identity_master (id, state, username, at) VALUES (1, 'wrapped', ?, ?) ON CONFLICT(id) DO UPDATE SET state = 'wrapped', username = excluded.username, at = excluded.at").run(name, Date.now());
        return forCaller(meta, { username: name, id: legacy.id, url: `https://vyre.run/u/${name}`, recoveryKey });
      });

    tool("identity.unlock", "Unlock this device with your master password or recovery key. An agent cannot supply either.",
      obj({ password: str, recovery: str }),
      async (input, meta) => {
        refuseModel(meta, input);
        if ((input.password == null || input.password === "") && (input.recovery == null || input.recovery === "")) throw refuse("Enter your master password on this device.", "person_enters");
        return M.unlockMaster({ root, password: input.password, recoveryCode: input.recovery, identityFile: idFile });
      });

    tool("identity.lock", "Lock this device and forget the unlocked keys in memory.",
      obj({}), async () => { M.lockMaster(idFile); return { locked: true }; });

    tool("identity.status", "Whether a username exists, whether it is unlocked, and whether the directory may show it.",
      obj({}), async () => M.masterStatus(root, idFile));

    tool("identity.migrate", "Wrap this device's existing keys under a new master password. The recovery key is shown once.",
      obj({ password: str }, ["password"]),
      async (input, meta) => {
        refuseModel(meta, input);
        if (input.password == null || input.password === "") throw refuse("Enter your master password on this device.", "person_enters");
        const recoveryKey = newRecoveryCode();
        const vaultKey = M.readVaultKeyFile(path.join(root, "vault", "key"));
        const made = M.migrateLegacy({ root, identityFile: idFile, password: input.password, recoveryCode: recoveryKey, vaultKey, kdf: kdf() });
        ctx.store.db.prepare("INSERT INTO identity_master (id, state, username, at) VALUES (1, 'wrapped', ?, ?) ON CONFLICT(id) DO UPDATE SET state = 'wrapped', username = excluded.username, at = excluded.at").run(made.username, Date.now());
        return forCaller(meta, { username: made.username, id: made.id, url: made.url, recoveryKey });
      });

    tool("identity.github.link", "Link a GitHub login to your username. The vault still needs your master password.",
      obj({ login: str, subject: str }, ["login", "subject"]),
      async (input) => M.linkGithub(root, { login: input.login, subject: input.subject }, idFile));

    tool("identity.discover", "Choose whether the public directory shows your username.",
      obj({ on: { type: "boolean" } }, ["on"]),
      async (input) => M.setDiscoverable(root, input.on === true, idFile));

    tool("identity.card", "The public card for your username. Private unless you opted in.",
      obj({}), async () => {
        const rec = M.readMaster(root);
        if (!rec) return { private: true, name: null };
        return publicCard({ name: rec.username, id: rec.id, discoverable: rec.discoverable === true, github: rec.github });
      });

    return { async stop() { M.lockMaster(idFile); } };
  },
};
