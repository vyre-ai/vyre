// @ts-check
// devices: sign a computer in with the space server, the username and the master password (ADR 0054). GitHub resolves the username and still asks for the password.

import { modelSuppliedSecret, SECRET_REFUSED } from "../../lib/master-secret.js";
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
      description: "Sign this device in with a server, your username and your master password.",
      input: obj({
        server: str,
        username: str,
        password: str,
        github: { type: "object", properties: { login: str, subject: str } },
      }, ["server", "password"]),
      run: async (input, meta) => {
        if (modelSuppliedSecret(meta && meta.caller, input, meta && meta.origin)) throw refuse(SECRET_REFUSED, "secret_refused");
        if (input.password == null || input.password === "") throw refuse("Enter your master password on this device.", "person_enters");
        const server = String(input.server || "").trim();
        if (!/^https?:\/\/[A-Za-z0-9._:-]{1,200}$/.test(server)) throw refuse("Give the space server address, starting with https://.", "bad_input");
        let username = input.username ? String(input.username).trim().toLowerCase().replace(/\.vyre\.run$/, "") : "";
        if (input.github && input.github.subject) {
          const link = M.githubOf(root);
          if (!link || link.subject !== String(input.github.subject)) throw refuse("That GitHub account is not linked to a username on this device.", "not_found");
          const rec = M.readMaster(root);
          username = rec ? rec.username : "";
        }
        if (!username) throw refuse("Give the username, or a linked GitHub account.", "bad_input");
        const opened = M.unlockMaster({ root, password: input.password, identityFile: M.identityPath(root) });
        if (username !== opened.username) throw refuse("That username does not match this device.", "bad_input");
        const id = `dev_${Date.now().toString(36)}`;
        ctx.store.db.prepare("INSERT INTO devices_signin (id, server, username, at) VALUES (?, ?, ?, ?)").run(id, server, opened.username, Date.now());
        return { ok: true, username: opened.username, id: opened.id, server, unlocked: true, carry: M.signinCarry(root) };
      },
    });
    return { async stop() {} };
  },
};
