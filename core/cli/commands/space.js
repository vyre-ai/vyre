// @ts-check
// `vyre space`: which space this terminal acts in. `vyre space use <name>` remembers one, `vyre space use --clear` forgets it, bare `vyre space` says what is remembered. `vyre call` passes it as `space`
// to any tool that takes one (and `--space <name>` overrides it for one call); with none, tools act in the home's own space and name it in their answer.
//
// --json shape: {space: string|null}.

import { call } from "../../daemon/client.js";
import { out, dim } from "../style.js";
import { json, emit, fail, usage, failTool } from "../kit.js";
import { readSpace, writeSpace } from "../space-pref.js";

export default {
  name: "space", order: 84, usage: "vyre space [use <name> | use --clear | add-agent <space> <agent>] [--json]", summary: "which space this terminal acts in",
  help: "`vyre space use harlow` remembers harlow for this terminal's calls. `vyre call records.list` then acts in it; `--space <name>` on one call overrides it. With none, calls act in the home's own space.",
  /** @param {string[]} args */
  async run(args) {
    const a = args.filter(x => x !== "--json");
    if (a.length === 0) {
      const s = readSpace();
      if (json()) return emit({ space: s }, { kind: "card", title: "Space", fields: [{ label: "Space", value: s || "the home's own space" }] });
      out(s ? `  acting in ${s}` : `  no space chosen ${dim("· calls act in the home's own space · vyre space use <name>")}`);
      return 0;
    }
    if (a[0] === "add-agent") {
      if (!a[1] || !a[2]) return usage("vyre space add-agent needs a space and an agent", "vyre space add-agent harlow assistant");
      const r = await call("spaces.members.add-agent", { space: a[1], agent: a[2] });
      if (r.error) return failTool(r.error);
      return json() ? emit(r.data, { kind: "card", title: "Agent added", fields: [{ label: "Space", value: a[1] }, { label: "Agent", value: a[2] }] }) : (out(`  ${a[2]} is now an agent of ${a[1]}`), 0);
    }
    if (a[0] !== "use") return usage("vyre space: say use <name>, use --clear or add-agent <space> <agent>", "vyre space use harlow");
    if (a[1] === "--clear") { writeSpace(null); return json() ? emit({ space: null }, { kind: "card", title: "Space", fields: [{ label: "Space", value: "cleared" }] }) : (out("  cleared"), 0); }
    const name = String(a[1] || "").trim();
    if (!name) return usage("vyre space use needs a space name", "vyre space use harlow");
    // Only a space this person can see is remembered.
    const r = await call("spaces.get", { space: name });
    if (r.error) return r.error.code === "not_found" ? fail(`no space called ${name}`, { next: "vyre call spaces.list" }) : failTool(r.error);
    writeSpace(String(r.data.id || name));
    return json() ? emit({ space: String(r.data.id || name) }, { kind: "card", title: "Space", fields: [{ label: "Space", value: name }] }) : (out(`  acting in ${name}`), 0);
  },
};
