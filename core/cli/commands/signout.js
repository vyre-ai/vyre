// @ts-check
// `vyre signout`: end this terminal's command-line session (see `vyre signin`).

import { call } from "../../daemon/client.js";
import { clearSession } from "../../../lib/cli-session.js";
import { out } from "../style.js";
import { json, emit, failTool } from "../kit.js";

export default {
  name: "signout", order: 83, usage: "vyre signout [--json]", summary: "sign this terminal out",
  /** @param {string[]} _args */
  async run(_args) {
    const r = await call("signin.end", {});
    clearSession();
    if (r.error && r.error.code !== "no_terminal" && r.error.code !== "unreachable") return failTool(r.error);
    if (json()) return emit({ signedOut: true });
    out("  Signed out.");
    return 0;
  },
};
