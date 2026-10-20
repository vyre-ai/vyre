// @ts-check
// `vyre signin` and `vyre signout`: the command line as the signed-in owner. A terminal over ssh, in tmux or through `docker exec` cannot be told from a program a model started, so the box asks the
// owner's phone (Face ID) once, and on a yes this terminal login holds a person session until it signs out or goes unused for 30 days (core/signin explains the pin).
//
// --json shapes: signin {signedIn, expires} · signout {signedOut}.

import { call } from "../../daemon/client.js";
import { ensureUp } from "../daemonctl.js";
import { writeSession } from "../../../lib/cli-session.js";
import { out, dim, beacon } from "../style.js";
import { json, emit, failTool } from "../kit.js";
import readline from "node:readline";
import { deriveLogin, loginMessage, acceptKdf } from "../../../kernel/identity/space-login.js";

const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

/** One line from the terminal. `hidden` shows nothing while it is typed (a password). null when there is no terminal to ask on. @param {string} question @param {boolean} hidden */
export function ask(question, hidden = false) {
  if (!process.stdin.isTTY) return Promise.resolve(null);
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (hidden) /** @type {any} */ (rl)._writeToOutput = (/** @type {string} */ t) => { if (t.includes(question)) process.stderr.write(t); };
    rl.question(question, answer => { rl.close(); if (hidden) process.stderr.write("\n"); resolve(answer); });
    rl.on("close", () => resolve(null));
  });
}

/**
 * Sign in with the space's username and password, the same door the app uses (core/signin explains it). Returns the exit code, or null when this computer has no space door, so the caller goes on to the phone.
 * The password and the key made from it stay in this process: only a signature over the one-use challenge is sent.
 * @param {{ ask?: typeof ask }} [seam]
 */
export async function passwordSignin(seam = {}) {
  const prompt = seam.ask || ask;
  const username = String((await prompt("  Username: ")) || "").trim().toLowerCase();
  if (!username) { out(beacon("  Type your username, or run `vyre signin` again.")); return 1; }
  const begun = await call("signin.password.begin", { username });
  if (begun.error) {
    if (begun.error.code === "unavailable") return null;
    out(beacon("  " + begun.error.message)); return 1;
  }
  const password = String((await prompt("  Password: ", true)) || "").normalize("NFKC");
  if (!password) { out(beacon("  Type your password, or run `vyre signin` again.")); return 1; }
  let kdf;
  try { kdf = acceptKdf(begun.data.kdf); } catch (e) { out(beacon("  " + /** @type {Error} */ (e).message)); return 1; }
  const d = deriveLogin(password, begun.data.salt, kdf);
  const sig = d.sign(loginMessage(String(begun.data.space || ""), username, begun.data.challenge));
  d.K.fill(0);
  const done = await call("signin.password.finish", { username, challenge: begun.data.challenge, sig });
  if (done.error) { out(beacon("  " + done.error.message)); return 1; }
  writeSession(done.data.token);
  if (json()) return emit({ signedIn: true, expires: done.data.expires });
  out("  Signed in. This terminal acts as you until `vyre signout`.");
  return 0;
}

export default {
  name: "signin", order: 82, usage: "vyre signin [--json]", summary: "sign in this terminal (approve on your phone)",
  help: "Asks your phone to approve. On a yes this terminal acts as you until `vyre signout`, or 30 days without use. Run it in a terminal you are logged in on.",
  /** @param {string[]} _args */
  async run(_args) {
    const up = await ensureUp();
    if (!up.ok) { out(beacon("  vyred did not start") + dim(` · its output is in ${up.log}`)); return 1; }
    // A server signs in by username and password, the same door the app uses; a computer with no space address asks the phone as before.
    const byPassword = await passwordSignin();
    if (byPassword !== null) return byPassword;
    const asked = await call("signin.ask", {});
    if (asked.error) {
      if (asked.error.code === "no_terminal") { out(beacon("  " + asked.error.message)); return 1; }
      return failTool(asked.error);
    }
    const { id, expires_in_s: life } = asked.data;
    if (!json()) out("  Approve on your phone.");
    const until = Date.now() + Number(life || 300) * 1000;
    while (Date.now() < until) {
      await sleep(2000);
      const r = await call("signin.status", { id });
      if (r.error) return failTool(r.error);
      const st = r.data && r.data.state;
      if (st === "approved") {
        writeSession(r.data.token);
        if (json()) return emit({ signedIn: true, expires: r.data.expires });
        out("  Signed in. This terminal acts as you until `vyre signout`.");
        return 0;
      }
      if (st === "refused") { out(beacon("  Your phone said no. Nothing changed.")); return 1; }
      if (st === "none") break;
    }
    out(beacon("  Not approved in time. Run `vyre signin` again."));
    return 1;
  },
};
