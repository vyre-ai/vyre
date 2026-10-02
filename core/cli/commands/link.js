// @ts-check
// `vyre link`: the Mac and the server as one system.
//
//   vyre link                   on the Mac: paired or not, and whether the server answers;
//                               on the server: paired Macs and waiting requests
//   vyre link pair <address>    on the Mac: start pairing, and show the code to approve in the Deck
//   vyre link approve <code>    on the server: approve the Mac showing that code. On a server this needs
//                               the owner's passkey, which only the Deck can give, so this points
//                               there when the passkey is missing (docs/adr/0004-presence.md)
//   vyre link deny <id>         on the server: refuse a request
//   vyre link unpair [id]       forget the server (on the Mac) or a Mac (on the server)
//   vyre link signin            on the Mac: sign this Mac's command line and Capsule in as you on
//                               the server for 30 days (your passkey, on the server's page), so they can
//                               answer asks and approve there (core/presence/person.js)
//   vyre link signout           on the Mac: only a device on the server again
//
// --json shapes: status, on a Mac, link.status {role, linked, box?, reachable?, pending?,
// signedIn?, error?}; on a server {role, peers, pending, waiting:[...], macs:[...]} · pair {code,
// expires} · approve {name, ...} · deny {refused} · unpair {unpaired} · signin {url, expires} ·
// signout {signedOut}. link pair shows a code to type, not a QR, so its view is a card.

import { call } from "../../daemon/client.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { json, emit, fail as failWith, failTool, usage } from "../kit.js";
import { openUrl } from "./up.js";
import { stream } from "../screen/live.js";

const fail = r => failTool(r.error);

/**
 * Wait for this Mac's sign-in to finish (link.signed-in), or the page to close. Resolves the new
 * session's expiry, or null. One event stream, no polling; when it opens, link.status is read once,
 * so a passkey confirmed before the stream was up still counts. `before` is the expiry of a session
 * this Mac already had, which is not a new sign-in.
 * @param {number} until ms @param {{ root?: string, before?: number }} [o] @returns {Promise<number|null>}
 */
export function signedIn(until, { root, before = 0 } = {}) {
  return new Promise(resolve => {
    /** @type {{ stop(): void } | null} */
    let s = null;
    let over = false;
    const done = (/** @type {number|null} */ v) => { if (over) return; over = true; clearTimeout(t); s?.stop(); resolve(v); };
    const t = setTimeout(() => done(null), Math.max(0, until - Date.now()));
    const fresh = (/** @type {any} */ x) => { const n = Number(x) || 0; if (n > before) done(n); };
    s = stream({ root,
      onEvent: e => { if (e.type === "link.signed-in") fresh(e.payload?.expires); },
      onOpen: () => { call("link.status", {}, root ? { root } : undefined).then(r => fresh(r.data?.signedIn?.expires), () => {}); } });
    if (over) s.stop();
  });
}
const ago = ms => { const s = Math.round((Date.now() - ms) / 1000); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };

async function status() {
  const r = await call("link.status");
  if (r.error) return fail(r);
  const s = r.data;
  if (json()) {
    if (s.role !== "box") {
      const where = s.box ? String(s.box.name || s.box.address) : "";
      return emit(s, { kind: "card", title: "Link", state: s.linked ? (s.reachable ? "ok" : "failed") : "wait", fields: [
        { label: "Box", value: s.linked ? where : "not paired" },
        ...(s.linked ? [{ label: "Answers", value: s.reachable ? "yes" : `not now${s.error ? ": " + s.error : ""}` }] : []),
        ...(s.pending ? [{ label: "Waiting for approval", value: `code ${s.pending.code}` }] : []),
        ...(s.linked ? [{ label: "Signed in on the server", value: s.signedIn ? `until ${new Date(s.signedIn.expires).toISOString().slice(0, 10)}` : "no: vyre link signin" }] : [])] });
    }
    const [p, peers] = await Promise.all([call("link.pending"), call("link.peers")]);
    const waiting = p.data || [], macs = peers.data || [];
    return emit({ ...s, waiting, macs }, { kind: "table", title: `${s.peers} paired Mac${s.peers === 1 ? "" : "s"} · ${s.pending} waiting`, empty: "No Macs paired or waiting",
      columns: [{ key: "name", label: "Mac" }, { key: "state", label: "State" }, { key: "node", label: "Node" }, { key: "id", label: "Id" }],
      rows: [...waiting.map(q => ({ ...q, state: "waiting" })), ...macs.map(m => ({ ...m, state: "paired" }))] });
  }
  if (s.role === "box") {
    out(`  ${bold(String(s.peers))} paired Mac${s.peers === 1 ? "" : "s"} · ${s.pending} waiting`);
    const p = await call("link.pending");
    for (const q of (p.data || [])) out(`  ${beacon("?")} ${q.name} ${dim(`${q.login}${q.node ? " · " + q.node : ""} · id ${q.id}`)}\n    ${dim("approve it in the Deck, on that Mac or your phone, with the code it shows")}`);
    const peers = await call("link.peers");
    for (const m of (peers.data || [])) out(`  ${signal("·")} ${m.name} ${dim(`${m.node || ""} · paired ${ago(m.paired_at)}${m.last_seen ? " · seen " + ago(m.last_seen) : ""} · id ${m.id}`)}`);
    return 0;
  }
  if (s.pending) out(`  waiting for approval: ${bold(s.pending.code)} ${dim("· approve it in the Deck, on this Mac or your phone, with your passkey")}`);
  if (!s.linked) { out(`  not paired with a server${s.error ? dim(" · " + s.error) : ""} ${dim("· vyre link pair <address>")}`); return 0; }
  const where = `${s.box.name || s.box.address}${s.box.node ? dim(" · " + s.box.node) : ""}`;
  out(s.reachable ? `  ${signal("●")} linked to ${where}` : `  ${beacon("○")} linked to ${where}, not reachable now${s.error ? dim(" · " + s.error) : ""}`);
  out(s.signedIn ? dim(`  signed in on the server until ${new Date(s.signedIn.expires).toLocaleDateString()}`) : dim("  not signed in on the server: vyre link signin, to answer and approve there from this Mac"));
  return 0;
}

const USAGE = "vyre link [status|pair <address>|approve <code>|deny <id>|unpair [id]|signin|signout] [--json]";

export default {
  name: "link", order: 45, usage: USAGE, summary: "pair this Mac with your server, or approve a Mac on the server",
  verbs: [
    { verb: "status", summary: "on the Mac: paired or not, and whether the server answers; on the server: paired Macs and waiting requests", usage: "", read: true },
    { verb: "pair", summary: "on the Mac: start pairing, and show the code to approve in the Deck", usage: "<address>" },
    { verb: "approve", summary: "on the server: approve the Mac showing that code (the Deck asks for your passkey)", usage: "<code>", person: true },
    { verb: "deny", summary: "on the server: refuse a request", usage: "<id>" },
    { verb: "unpair", summary: "forget the server (on the Mac) or a Mac (on the server)", usage: "[id]" },
    { verb: "signin", summary: "on the Mac: sign this Mac in as you on the server for 30 days, with your passkey", usage: "", person: true },
    { verb: "signout", summary: "on the Mac: only a device on the server again", usage: "" },
  ],
  async run(args) {
    const [sub, arg] = args.filter(a => a !== "--json");
    if (!sub || sub === "status") return status();
    if (sub === "pair") {
      if (!arg) return usage("vyre link pair needs your server's address", "vyre link pair <address>, e.g. vyre link pair alex.vyre.run");
      const r = await call("link.pair", { box: arg });
      if (r.error) return fail(r);
      if (json()) {
        return emit(r.data, { kind: "card", title: "Approve this Mac in the Deck", state: "wait", fields: [{ label: "Code", value: String(r.data.code) },
          { label: "Where", value: "the Deck, on this Mac or your phone, with your passkey" }, { label: "Expires", value: `in ${Math.round((r.data.expires - Date.now()) / 60000)} minutes` }] });
      }
      out(`  approve this Mac in the Deck, on this Mac or your phone, with the code  ${bold(r.data.code)}`);
      out(dim(`  The Deck names this Mac and asks for your passkey. The code expires in ${Math.round((r.data.expires - Date.now()) / 60000)} minutes.`));
      return 0;
    }
    if (sub === "approve") {
      if (!arg) return usage("vyre link approve needs the code the Mac shows", "vyre link approve <code>, or approve it in the Deck");
      const r = await call("link.pair.approve", { code: arg });
      // A terminal is not proof the owner is here (a model can ssh in with the code), so the server
      // asks for a passkey, and only the Deck can give one.
      if (r.error && r.error.code === "presence_required") {
        if (json()) return failWith("approving a Mac needs your passkey, which only the Deck can give", { code: "presence_required", exit: 3, next: `approve it in the Deck, on that Mac or your phone (the code is ${arg})` });
        out(`  approve it in the Deck, on that Mac or your phone: it names the Mac asking and asks for your passkey ${dim("(the code is " + arg + ")")}`);
        return 3;
      }
      if (r.error) return fail(r);
      if (json()) return emit(r.data);
      out(`  ${signal("●")} paired with ${bold(r.data.name)}`);
      return 0;
    }
    if (sub === "deny") {
      const r = await call("link.pair.deny", { id: String(arg || "") });
      if (r.error) return fail(r);
      if (json()) return emit({ refused: String(arg || ""), ...(r.data && typeof r.data === "object" ? r.data : {}) });
      out("  refused");
      return 0;
    }
    if (sub === "unpair") {
      const r = await call("link.unpair", arg ? { id: arg } : {});
      if (r.error) return fail(r);
      if (json()) return emit(r.data);
      out(r.data.unpaired ? "  unpaired" : "  was not paired");
      return 0;
    }
    if (sub === "signin") {
      const had = (await call("link.status")).data?.signedIn?.expires || 0;
      const r = await call("link.signin", {});
      if (r.error) return fail(r);
      if (json()) return emit(r.data, { kind: "card", title: "Confirm with your passkey", state: "wait", fields: [{ label: "Open", value: String(r.data.url) },
        { label: "Then", value: "this Mac's command line and Capsule can answer and approve on the server for 30 days" }] });
      openUrl(r.data.url);
      out(`  confirm with your passkey on your server's page: ${bold(r.data.url)}`);
      out(dim(`  This Mac's command line and Capsule can then answer and approve on the server for 30 days. The page is open for ${Math.round((r.data.expires - Date.now()) / 60000)} minutes.`));
      // At a terminal, wait for the passkey and say how it went; a script gets the link and goes.
      if (!process.stdout.isTTY) return 0;
      const expires = await signedIn(r.data.expires, { before: had });
      if (!expires) { out("  the sign-in page closed before a passkey confirmed it: run vyre link signin again"); return 1; }
      out(`  signed in on the server until ${new Date(expires).toLocaleDateString()}`);
      return 0;
    }
    if (sub === "signout") {
      const r = await call("link.signout", {});
      if (r.error) return fail(r);
      if (json()) return emit(r.data);
      out(r.data.signedOut ? "  signed out on the server" : "  was not signed in");
      return 0;
    }
    return usage(`vyre link ${sub}: not a subcommand`, USAGE.replace(" [--json]", ""));
  },
};
