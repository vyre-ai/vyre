// @ts-check
// `vyre send <file> [more files]`: send files from this Mac to the box with Taildrop.
//
// Each file is one files.send call, in turn, with one line for each. A refused or failed file
// does not stop the rest; the exit code says whether any failed. --json prints one value at the
// end: { sent: [{ file, sent, bytes, to }], failed: [{ file, error: { code, message } }] }, both
// always there. No file at all is a usage mistake: exit 2.

import path from "node:path";
import { call } from "../../daemon/client.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { json, emit, failTool, usage } from "../kit.js";

/** A send waits for Taildrop to finish, so a large file needs longer than a tool call usually gets. */
const TIMEOUT = 61 * 60_000;

const size = n => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;

export default {
  name: "send", order: 46, usage: "vyre send <file...> [--json]", summary: "send files from this Mac to your box with Taildrop",
  // No verbs: every word is a file (vyre commands --json reads its args from the usage line).
  verbs: [],
  async run(args) {
    const files = args.filter(a => a !== "--" && a !== "--json");
    if (!files.length) return usage("vyre send <file> [more files]: which files?", "vyre send ./notes.txt");
    const sent = [], failed = [];
    for (const f of files) {
      const r = await call("files.send", { path: path.resolve(f) }, { timeout: TIMEOUT });
      if (r.error && r.error.code === "unreachable") {
        if (json()) return failTool(r.error);
        out(`  vyred is not running ${dim("· vyre up to start it")}`);
        return 1;
      }
      if (r.error) {
        failed.push({ file: f, error: { code: r.error.code, message: r.error.message } });
        if (!json()) out(`  ${beacon("○")} ${f} ${dim("· " + r.error.message)}`);
        continue;
      }
      sent.push({ file: f, ...r.data });
      if (!json()) out(`  ${signal("●")} ${bold(r.data.sent)} ${dim(`${size(r.data.bytes)} · to ${r.data.to}`)}`);
    }
    if (json()) {
      const rows = [...sent.map(x => ({ file: x.file, state: "sent", note: `${size(x.bytes)} · to ${x.to}` })),
        ...failed.map(x => ({ file: x.file, state: "failed", note: x.error.message }))];
      emit({ sent, failed }, { kind: "table", title: "Sent with Taildrop", columns: [{ key: "file", label: "File" }, { key: "state", label: "" }, { key: "note", label: "" }], rows });
    }
    return failed.length ? 1 : 0;
  },
};
