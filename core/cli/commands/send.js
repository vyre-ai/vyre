// @ts-check
// `vyre send <file> [more files]`: send files from this Mac to the box with Taildrop.
//
// Each file is one files.send call, in turn, with one line for each. A refused or failed file
// does not stop the rest; the exit code says whether any failed.

import path from "node:path";
import { call } from "../../daemon/client.js";
import { out, dim, bold, signal, beacon } from "../style.js";

/** A send waits for Taildrop to finish, so a large file needs longer than a tool call usually gets. */
const TIMEOUT = 61 * 60_000;

const size = n => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;

export default {
  name: "send", order: 46, usage: "vyre send <file> [more files]", summary: "send files from this Mac to your box with Taildrop",
  async run(args) {
    const files = args.filter(a => a !== "--");
    if (!files.length) { out("  vyre send <file> [more files]"); return 1; }
    let failed = 0;
    for (const f of files) {
      const r = await call("files.send", { path: path.resolve(f) }, { timeout: TIMEOUT });
      if (r.error && r.error.code === "unreachable") {
        out(`  vyred is not running ${dim("· vyre up to start it")}`);
        return 1;
      }
      if (r.error) { failed++; out(`  ${beacon("○")} ${f} ${dim("· " + r.error.message)}`); continue; }
      out(`  ${signal("●")} ${bold(r.data.sent)} ${dim(`${size(r.data.bytes)} · to ${r.data.to}`)}`);
    }
    return failed ? 1 : 0;
  },
};
