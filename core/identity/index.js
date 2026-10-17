// @ts-check
// identity: the username, the master password and the one-screen recovery key (ADR 0054). The chain itself stays spaces.identity.create.
// This module wraps the keys that file already holds. A model caller cannot supply the password or the recovery key.

import fs from "node:fs";
import path from "node:path";
import { isPerson } from "../../lib/caller.js";
import { claim as claimGithub } from "../../lib/github-verified.js";
import { modelSuppliedSecret, SECRET_REFUSED } from "../../lib/master-secret.js";
import { newRecoveryCode } from "../../kernel/identity/code.js";
import * as M from "../../kernel/identity/master.js";
import { checkUsername, publicCard } from "../../kernel/identity/username.js";
import { startLogin } from "./login-start.js";
import { registerSignins } from "./signins.js";

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
        const r = await ctx.call("spaces.identity.create", { name, password: "", ...(input.code ? { code: input.code } : {}), ...(input.deviceLabel ? { deviceLabel: input.deviceLabel } : {}) }, { relay: true });
        if (!r || r.error) throw refuse((r && r.error && r.error.message) || "The name could not be claimed. Try again.", (r && r.error && r.error.code) || "failed");
        const recoveryKey = r.data && r.data.recoveryCode;
        if (!recoveryKey) throw refuse("The identity did not return a recovery key. Try again.", "failed");
        const legacy = JSON.parse(fs.readFileSync(idFile, "utf8"));
        const vaultKey = M.serverVaultKey(root);
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

    const answered = (/** @type {any} */ r) => (r && r.data !== undefined ? r.data : r);

    tool("identity.vault.install", "Install the unlocked master key into the running vault and return the published public key. No private key.",
      obj({ space: str }),
      async (input, meta) => {
        refuseModel(meta, input);
        let installed = null;
        try {
          const r = await ctx.call("vault.master.install", {}, { relay: true });
          if (!r || r.error) throw refuse((r && r.error && r.error.message) || "Unlock this identity on this device before the vault can take the master key.", (r && r.error && r.error.code) || "locked");
          installed = answered(r);
        } catch (e) {
          const err = /** @type {any} */ (e);
          throw refuse(err.message || "Unlock this identity on this device before the vault can take the master key.", err.code === "not_found" ? "not_found" : "locked");
        }
        if (!installed || installed.installed !== true || installed.plaintext !== false) throw refuse("The vault did not take the master key.", "locked");
        let id = M.masterStatus(root, idFile).id || null;
        let deviceKey = null;
        try {
          const r = await ctx.call("spaces.identity.self", {}, { relay: true });
          const self = r && r.error ? null : answered(r);
          if (self && self.id) id = self.id;
        } catch { /* the master record still names the person */ }
        try {
          const r = await ctx.call("spaces.identity.device", {}, { relay: true });
          const device = r && r.error ? null : answered(r);
          if (device && typeof device.deviceKey === "string") deviceKey = device.deviceKey;
        } catch { deviceKey = null; }
        let space = null;
        if (input && input.space) {
          let published = null;
          try {
            const r = await ctx.call("spaces.identity.published-key", { space: String(input.space) }, { relay: true });
            if (!r || r.error) throw refuse((r && r.error && r.error.message) || "This space has no published key on this device yet. Install or restore the space here first, then try again.", "not_found");
            published = answered(r);
          } catch (e) {
            const err = /** @type {any} */ (e);
            throw refuse(err.message || "This space has no published key on this device yet. Install or restore the space here first, then try again.", "not_found");
          }
          if (!published || typeof published.pub !== "string" || !published.pub) throw refuse("This space has no published key on this device yet. Install or restore the space here first, then try again.", "not_found");
          space = { id: String(input.space), pub: published.pub };
        }
        return forCaller(meta, { installed: true, plaintext: false, id, deviceKey, space });
      },
      obj({ installed: { type: "boolean" }, plaintext: { type: "boolean" }, id: str, deviceKey: str, space: obj({ id: str, pub: str }) }));

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
        const vaultKey = M.serverVaultKey(root);
        const made = M.migrateLegacy({ root, identityFile: idFile, password: input.password, recoveryCode: recoveryKey, vaultKey, kdf: kdf() });
        ctx.store.db.prepare("INSERT INTO identity_master (id, state, username, at) VALUES (1, 'wrapped', ?, ?) ON CONFLICT(id) DO UPDATE SET state = 'wrapped', username = excluded.username, at = excluded.at").run(made.username, Date.now());
        return forCaller(meta, { username: made.username, id: made.id, url: made.url, recoveryKey });
      });

    tool("identity.github.link", "Link a GitHub login to your username. The vault still needs your master password.",
      obj({ login: str, subject: str }, ["login", "subject"]),
      async (input) => {
        // Only an account GitHub confirmed (onboard.github.finish vouches after the token exchange) is linked. A login and an id typed here, or sent by an agent, are not.
        if (!claimGithub(String(input.login || "").trim().toLowerCase(), String(input.subject || "").trim())) throw refuse("Sign in with GitHub first. A GitHub login typed here is not linked.", "github_unverified");
        return M.linkGithub(root, { login: input.login, subject: input.subject }, idFile);
      });

    tool("identity.discover", "Choose whether the public directory shows your username.",
      obj({ on: { type: "boolean" } }, ["on"]),
      async (input) => M.setDiscoverable(root, input.on === true, idFile));

    tool("identity.card", "The public card for your username. Private unless you opted in.",
      obj({}), async () => {
        const rec = M.readMaster(root);
        if (!rec) return { private: true, name: null };
        return publicCard({ name: rec.username, id: rec.id, discoverable: rec.discoverable === true, github: rec.github });
      });

    // The sign-ins on a new device that wait on the person: read, vouch for or sign out, for the owner's own username (signins.js).
    registerSignins(ctx, { username: () => { try { const r = M.readMaster(root); return r && typeof r.username === "string" ? r.username : null; } catch { return null; } } });

    let login = { async stop() {} };
    try { login = await startLogin(ctx); } catch (e) { ctx.log && ctx.log(`identity: no sign-in door (${/** @type {Error} */ (e).message})`); }
    return { async stop() { await login.stop(); M.lockMaster(idFile); } };
  },
};
