// @ts-check
// `vyre space`: this server's space, and which space this terminal acts in.
//   vyre space                        the space's details in plain lines: name and address, owner, members, Records, vault, version, and the next step if anything is missing
//   vyre space up                     where to set this server's space up from the Vyre app (the install command it shows); says so when it is already set up
//   vyre space use <name>             remembers a space for this terminal's calls, `use --clear` forgets it. `vyre call` passes it as `space` to any tool that takes one (and `--space <name>`
//                                     overrides it for one call); with none, tools act in the home's own space and name it in their answer.
//
// Built from tools that exist: wink.server.status, spaces.list, spaces.get, vault.list and /v1/health. No new kernel logic.
// --json shapes: bare {running, version, home: {id, name, address}|null, space: the remembered space or null, owned, owner, members, owners, records, vault, next} (vyred down: {running: false, space, next}); up {owned: false, code, code_expires, words, qr} or {owned: true, space};
// use {space: string|null}.

import { call, request } from "../../daemon/client.js";
import { label } from "../../daemon/build.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { EXIT, json, emit, fail, usage, failTool } from "../kit.js";
import { readSpace, writeSpace } from "../space-pref.js";

/** `vyre space up`: where this server's space is set up from: the app's install command. */
async function up() {
  const st = await call("wink.server.status", {});
  if (st.error) return failTool(st.error);
  if (st.data && st.data.owned) {
    const where = st.data.space ? ` to ${st.data.space}` : "";
    if (json()) return emit({ owned: true, ...(st.data.space ? { space: String(st.data.space) } : {}) }, { kind: "card", title: "Space", state: "ok", fields: [{ label: "Space", value: `already set up${where}` }] });
    out(`  This space is already set up${where}.`);
    out(dim("  To add a device, open the Vyre app on it and choose this space, or run: vyre phone add"));
    return 0;
  }
  const message = "This server is not set up yet. In the Vyre app choose Create a space, pick Linux or Mac, and run the install command it shows on this server. It carries a pair code made from your identity.";
  if (json()) return emit({ owned: false, next: "run the install command from the Vyre app (Create a space) on this server" }, { kind: "card", title: "Space", state: "wait", fields: [{ label: "Space", value: "not set up yet" }, { label: "Next", value: "Create a space in the Vyre app and run its install command here" }] });
  out("");
  out(`  ${message}`);
  out("");
  return 0;
}

/** `vyre space`: the details, in plain lines. */
async function details() {
  const h = await request("GET", "/v1/health");
  if (h.error) {
    // The remembered space is a file, so it can still be said; the rest needs vyred.
    if (json()) { emit({ running: false, space: readSpace(), next: ["vyre up"] }); return EXIT.UNREACHABLE; }
    if (readSpace()) out(`  acting in ${readSpace()}`);
    return fail("vyred is not answering, so there is no space to show", { next: "vyre up", exit: EXIT.UNREACHABLE });
  }
  const d = h.data || {};
  const [st, list, vault] = await Promise.all([call("wink.server.status", {}), call("spaces.list", {}), call("vault.list", {})]);
  const rows = Array.isArray(list.data) ? list.data : [];
  const row = rows[0] || null;
  const got = row ? await call("spaces.get", { space: String(row.id) }) : null;
  const g = got && got.data ? got.data : null;
  const owned = Boolean(st.data && st.data.owned);
  const owner = owned ? `${st.data.space || "someone"}${st.data.device ? ` (paired by ${st.data.device})` : ""}` : null;
  const rs = d.records_store || null;
  const recordsLine = rs ? `${rs.store === "twenty" ? "Records" : rs.store === "builtin" ? "built-in store" : rs.store === "none" ? "none" : rs.store}${rs.records === null || rs.records === undefined ? "" : ` · ${rs.records} records`}${rs.note ? ` · ${rs.note}` : ""}` : "no answer";
  const items = vault.data && Array.isArray(vault.data.items) ? vault.data.items.length : null;
  const vaultLine = items === null ? "not answering" : items === 0 ? "empty" : `${items} item${items === 1 ? "" : "s"}`;
  const nameOf = row ? String(row.displayName || row.label || row.name || row.id) : null;
  const address = row && row.name && /\./.test(String(row.name)) ? String(row.name) : null;
  // What is missing, in the order it blocks the person.
  /** @type {string[]} */ const next = [];
  if (!owned) next.push("Set this server up from the Vyre app: vyre space up");
  if (rs && rs.note) next.push("Records is still setting up; check again in a few minutes: vyre space");
  if (items === null) next.push("The vault did not answer; see: vyre doctor");
  if (!row && owned) next.push("This server lists no space yet; see: vyre doctor");
  const data = { running: true, version: label(d), home: row ? { id: String(row.id), name: nameOf, address } : null, space: readSpace(), owned, owner, members: g ? g.members : null, owners: g ? g.owners : null,
    records: recordsLine, vault: vaultLine, next };
  if (json()) return emit(data, { kind: "card", title: "Space", state: next.length ? "wait" : "ok", fields: [
    { label: "Space", value: nameOf ? `${nameOf}${address ? ` · ${address}` : ""}` : "not set up" }, { label: "Owner", value: owner || "nobody yet" },
    { label: "Members", value: g ? String(g.members) : "unknown" }, { label: "Records", value: recordsLine }, { label: "Vault", value: vaultLine }, { label: "Version", value: label(d) },
    ...(next.length ? [{ label: "Next", value: next[0] }] : [])] });
  out(`  Space     ${nameOf ? `${bold(nameOf)}${address ? dim(` · ${address}`) : ""}` : beacon("not set up")}`);
  out(`  Owner     ${owner || beacon("nobody yet")}`);
  out(`  Members   ${g ? `${g.members}${g.owners ? dim(` · ${g.owners} owner${g.owners === 1 ? "" : "s"}`) : ""}` : dim("unknown")}`);
  out(`  Records   ${recordsLine}`);
  out(`  Vault     ${vaultLine}`);
  out(`  Version   ${label(d)}`);
  if (readSpace()) out(`  Acting in ${readSpace()} ${dim("· vyre space use --clear to go back to the home's own space")}`);
  if (next.length) { out(""); for (const n of next) out(`  ${signal("Next")}  ${n}`); }
  return 0;
}

export default {
  name: "space", order: 84, usage: "vyre space [up | use <name> | use --clear | add-agent <space> <agent>] [--json]", summary: "this server's space: its details, where it is set up from, and which space this terminal acts in",
  help: "`vyre space` shows the space's name, owner, members, Records, vault and version. `vyre space up` says where a server that is not set up yet is set up from: the install command in the Vyre app. `vyre space use harlow` remembers harlow for this terminal's calls: `vyre call records.list` then acts in it, and `--space <name>` on one call overrides it. With none, calls act in the home's own space.",
  /** @param {string[]} args */
  async run(args) {
    const a = args.filter(x => x !== "--json");
    if (a.length === 0) return details();
    if (a[0] === "up") return a.length === 1 ? up() : usage(`vyre space up takes no arguments (got ${a[1]})`, "vyre space up");
    if (a[0] === "add-agent") {
      if (!a[1] || !a[2]) return usage("vyre space add-agent needs a space and an agent", "vyre space add-agent harlow assistant");
      const r = await call("spaces.members.add-agent", { space: a[1], agent: a[2] });
      if (r.error) return failTool(r.error);
      return json() ? emit(r.data, { kind: "card", title: "Agent added", fields: [{ label: "Space", value: a[1] }, { label: "Agent", value: a[2] }] }) : (out(`  ${a[2]} is now an agent of ${a[1]}`), 0);
    }
    if (a[0] !== "use") return usage("vyre space: say up, use <name>, use --clear or add-agent <space> <agent>", "vyre space use harlow");
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
