// @ts-check
// `vyre presence`: the keys that can prove a person is here (Capsule keys and Deck passkeys), a
// one-time code for enrolling a passkey from the Deck, and removing a key. See ADR 0004.
//
// --json shapes: keys [{id, kind, label?, created?}] · code {code} · remove {removed}.

import { callAsPerson, realIO, NO_TERMINAL } from "../presence.js";
import { out, dim, bold, signal } from "../style.js";
import { json, emit, failTool, usage, viewing } from "../kit.js";

const USAGE = "vyre presence [keys|code|remove <id>] [--json]";
const fail = r => failTool(r.error);

/**
 * The terminal a presence proof is asked on. Under --view (the Capsule, chat or the phone runs
 * the verb and draws it) there is no prompt to type into, so a tool that needs a person answers
 * no_terminal, exit 3, instead of opening /dev/tty. The other commands that ask presence use it too.
 * @returns {import("../presence.js").PresenceIO}
 */
export function personIO() {
  if (!viewing()) return realIO;
  return { ...realIO, openTty() { throw new Error(NO_TERMINAL); } };
}

export default {
  name: "presence", order: 80, usage: USAGE, summary: "the keys that prove you are here, and a code to enroll a passkey",
  verbs: [
    { verb: "keys", aliases: ["list", "ls"], summary: "the keys that can prove you are here", usage: "", read: true },
    { verb: "code", summary: "a one-time code to enroll a passkey from the Deck", usage: "", person: true },
    { verb: "remove", aliases: ["rm"], summary: "remove a key", usage: "<id>", person: true },
  ],
  async run(args) {
    const [sub0 = "keys", ...rest] = args.filter(a => a !== "--json");
    const sub = ({ list: "keys", ls: "keys", rm: "remove" })[sub0] || sub0;
    const io = personIO();
    if (sub === "keys") {
      const r = await callAsPerson("presence.keys", {}, { io });
      if (r.error) return fail(r);
      const keys = Array.isArray(r.data) ? r.data : r.data?.keys || [];
      if (json()) {
        return emit(keys, { kind: "table", title: "Keys", empty: "No keys enrolled yet",
          columns: [{ key: "id", label: "Id" }, { key: "kind", label: "Kind" }, { key: "label", label: "Label" }, { key: "created", label: "Created" }], rows: keys });
      }
      if (!keys.length) { out(dim("  no keys enrolled · the Capsule enrolls one at first run, the Deck with vyre presence code")); return 0; }
      for (const k of keys) {
        const when = k.created ? new Date(k.created).toISOString().slice(0, 10) : "";
        out(`  ${bold(String(k.id))} ${k.kind || ""} ${k.label ? k.label + " " : ""}${dim(when)}`);
      }
      return 0;
    }
    if (sub === "code") {
      const r = await callAsPerson("presence.code", {}, { io });
      if (r.error) return fail(r);
      const code = typeof r.data === "string" ? r.data : r.data?.code;
      if (json()) {
        return emit({ code }, { kind: "card", title: "Passkey code", state: "wait",
          fields: [{ label: "Code", value: String(code) }, { label: "Where", value: "type it into the Deck; it works once and lasts 10 minutes" }] });
      }
      out(`  ${signal(String(code))}`);
      out(dim("  Type this into the Deck to enroll its passkey. It works once and lasts 10 minutes."));
      return 0;
    }
    if (sub === "remove") {
      const id = rest[0];
      if (!id) return usage("vyre presence remove needs a key id", "vyre presence keys lists them");
      const r = await callAsPerson("presence.remove", { id }, { io });
      if (r.error) return fail(r);
      if (json()) return emit({ removed: id });
      out(`  removed key ${bold(id)}`);
      return 0;
    }
    return usage(`vyre presence ${sub}: not a subcommand`, "vyre presence keys, code or remove <id>");
  },
};
