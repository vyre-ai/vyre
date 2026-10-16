// @ts-check
// devices: sign a computer in on any of the person's space servers, with the username and the master password (ADR 0054). Each space has its own server. GitHub resolves the username and still asks for the password.

import { isPerson } from "../../lib/caller.js";
import { modelSuppliedSecret, SECRET_REFUSED } from "../../lib/master-secret.js";
import { redactSecrets, secretSchema } from "../../lib/secret-schema.js";
import * as M from "../../kernel/identity/master.js";

const MIGRATIONS = [
  `CREATE TABLE devices_signin (
    id TEXT PRIMARY KEY,
    server TEXT NOT NULL,
    username TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
];

const obj = (properties, required = []) => ({ type: "object", properties, required });
const str = { type: "string" };
const refuse = (message, code) => Object.assign(new Error(message), { code });

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const root = ctx.paths.root;
    ctx.tool("devices.signin", {
      description: "Sign this device in on a space server you belong to, with your username and master password.",
      input: obj({
        server: str,
        username: str,
        password: secretSchema("master-record"),
        github: { type: "object", properties: { login: str, subject: str } },
      }, ["server", "password"]),
      output: obj({
        ok: { type: "boolean" }, username: str, id: str, server: str, unlocked: { type: "boolean" },
        carry: obj({
          passwordWrap: secretSchema("master-record"),
          identityWrap: secretSchema("master-record"),
          vaultWrap: secretSchema("master-record"),
          boxPub: str,
        }),
      }),
      run: async (input, meta) => {
        if (modelSuppliedSecret(meta && meta.caller, input)) throw refuse(SECRET_REFUSED, "secret_refused");
        if (input.password == null || input.password === "") throw refuse("Enter your master password on this device.", "person_enters");
        const server = String(input.server || "").trim();
        if (!/^https?:\/\/[A-Za-z0-9._:-]{1,200}$/.test(server)) throw refuse("Give the space server address, starting with https://.", "bad_input");
        let username = input.username ? String(input.username).trim().toLowerCase().replace(/\.vyre\.run$/, "") : "";
        if (input.github && input.github.subject) {
          const link = M.githubOf(root);
          if (!link || link.subject !== String(input.github.subject)) throw refuse("That GitHub account is not linked to a username on this device. Link it with identity.github.link, then try again.", "not_found");
          const rec = M.readMaster(root);
          username = rec ? rec.username : "";
        }
        if (!username) throw refuse("Give the username, or a linked GitHub account.", "bad_input");
        const opened = M.unlockMaster({ root, password: input.password, identityFile: M.identityPath(root) });
        if (username !== opened.username) throw refuse("That username does not match this device.", "bad_input");
        const id = `dev_${Date.now().toString(36)}`;
        ctx.store.db.prepare("INSERT INTO devices_signin (id, server, username, at) VALUES (?, ?, ?, ?)").run(id, server, opened.username, Date.now());
        const shown = { ok: true, username: opened.username, id: opened.id, server, unlocked: true, carry: M.signinCarry(root) };
        return isPerson(meta && meta.caller) ? shown : redactSecrets(shown).value;
      },
    });
    return { async stop() {} };
  },
};
