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

const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

export default {
  name: "signin", order: 82, usage: "vyre signin [--json]", summary: "sign in this terminal (approve on your phone)",
  help: "Asks your phone to approve. On a yes this terminal acts as you until `vyre signout`, or 30 days without use. Run it in a terminal you are logged in on.",
  /** @param {string[]} _args */
  async run(_args) {
    const up = await ensureUp();
    if (!up.ok) { out(beacon("  vyred did not start") + dim(` · its output is in ${up.log}`)); return 1; }
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
