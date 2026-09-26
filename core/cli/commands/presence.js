// @ts-check
// `vyre presence`: the keys that can prove a person is here (Capsule keys and Deck passkeys), a
// one-time code for enrolling a passkey from the Deck, and removing a key. See ADR 0004.

import { callAsPerson } from "../presence.js";
import { out, dim, bold, signal, beacon } from "../style.js";

const USAGE = "vyre presence [keys|code|remove <id>]";
const fail = r => {
  const down = ["unreachable", "timeout"].includes(r.error.code);
  out(down ? `  vyred is not running ${dim("· vyre up to start it")}` : beacon(`  ${r.error.code}: `) + r.error.message);
  return 1;
};

export default {
  name: "presence", order: 80, usage: USAGE, summary: "the keys that prove you are here, and a code to enroll a passkey",
  async run([sub = "keys", ...rest]) {
    if (sub === "keys") {
      const r = await callAsPerson("presence.keys", {});
      if (r.error) return fail(r);
      const keys = Array.isArray(r.data) ? r.data : r.data?.keys || [];
      if (!keys.length) { out(dim("  no keys enrolled · the Capsule enrolls one at first run, the Deck with vyre presence code")); return 0; }
      for (const k of keys) {
        const when = k.created ? new Date(k.created).toISOString().slice(0, 10) : "";
        out(`  ${bold(String(k.id))} ${k.kind || ""} ${k.label ? k.label + " " : ""}${dim(when)}`);
      }
      return 0;
    }
    if (sub === "code") {
      const r = await callAsPerson("presence.code", {});
      if (r.error) return fail(r);
      const code = typeof r.data === "string" ? r.data : r.data?.code;
      out(`  ${signal(String(code))}`);
      out(dim("  Type this into the Deck to enroll its passkey. It works once and lasts 10 minutes."));
      return 0;
    }
    if (sub === "remove") {
      const id = rest[0];
      if (!id) { out(`  vyre presence remove <id>`); return 1; }
      const r = await callAsPerson("presence.remove", { id });
      if (r.error) return fail(r);
      out(`  removed key ${bold(id)}`);
      return 0;
    }
    out(`  ${USAGE}`);
    return 1;
  },
};
