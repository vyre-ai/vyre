// @ts-check
// `vyre kit`: the Kits this build ships, and `vyre kit deploy <kit>` to put one on the Space in one step.
//
//   vyre kit                          the Kits on offer, and which are installed or waiting
//   vyre kit deploy <kit>             propose the Kit (and the Kit it needs first, if any) for your yes
//   vyre kit deploy <file|url>        propose a Kit from a file on this computer or from an https address
//
// A Kit read from a file or an address is proposed the same way a Kit of the library is: the card
// waits for the owner's yes and nothing installs until they say it. The token of a private address
// comes from the Vault with the person's yes, is used for that one request and is never kept.

import { call } from "../../daemon/client.js";
import { ensureUp } from "../daemonctl.js";
import { out, dim, beacon, signal } from "../style.js";
import { json, emit, failTool, UsageError, parse, fail, usage, exitFor, nextFor, EXIT } from "../kit.js";
import { checkSource, looksLikeSource } from "../../lib/kit-source.js";
import { readKit, tokenRef, vaultToken } from "../kit-source.js";

export default {
  name: "kit", order: 70, usage: "vyre kit [deploy <kit|file|https-address>] [--token vault://item/field] [--json]", summary: "the Kits Vyre ships, and putting one on this Space",
  help: "List them:\n  vyre kit                  the Kits on offer, with what each adds and whether it is installed\nPut one on this Space:\n  vyre kit deploy <kit>     propose the Kit, and the Kit it needs first, in one step. Each waits for your yes in Now; nothing installs until you say it (vyre needs).\n  vyre kit deploy <file>    propose a Kit from a file on this computer, the same way.\n  vyre kit deploy <url>     propose a Kit from an https address. A private one takes --token vault://item/field; the token is used for that one request and never kept.",
  /** @param {string[]} args */
  async run(args) {
    const { flags, pos } = parse(args, { values: ["token"], cmd: "kit" });
    const up = await ensureUp();
    if (!up.ok) { out(beacon("  vyred did not start") + dim(` · its output is in ${up.log}`)); return 1; }
    if (pos[0] === "deploy") {
      const what = pos[1];
      if (!what) throw new UsageError("vyre kit deploy <kit>");
      // A path or an address is a Kit to install from; a plain word is one of the Kits this build ships.
      if (looksLikeSource(what)) return deployFrom(what, flags.token ? String(flags.token) : "");
      return deployLibrary(what);
    }
    return listKits();
  },
};

/**
 * The Kits on offer, and the ones on this Space: each with the version it is at and where it came
 * from.
 */
async function listKits() {
  const lib = await call("flows.kit.library", {});
  if (lib.error) return failTool(lib.error);
  const kits = /** @type {any[]} */ (lib.data.kits);
  const have = await call("flows.kit.list", {});
  // A Kit that was taken away is not on this Space any more.
  const rows = /** @type {any[]} */ ((have.error ? [] : (have.data.kits || have.data || [])).filter((/** @type {any} */ k) => k.status !== "removed"));
  const installed = new Map(rows.filter((/** @type {any} */ k) => !k.status || k.status === "installed").map((/** @type {any} */ k) => [k.id ?? k.kit_id, k]));
  if (json()) return emit({ kits: kits.map(k => ({ ...k, installed: installed.has(k.id) })), space_kits: rows.map(row => ({ id: row.id ?? row.kit_id, version: row.version, status: row.status, source: row.source || null })) });
  for (const k of kits) out(`  ${k.id.padEnd(18)} ${installed.has(k.id) ? signal("installed") : dim("not installed")}  ${dim(k.description)}`);
  if (rows.length) {
    out(dim("\n  on this Space:"));
    for (const r of rows) {
      const bits = [`version ${r.version}`, r.status || "installed"];
      if (r.source) bits.push(`from ${r.source}`);
      out(`  ${String(r.id ?? r.kit_id ?? "").padEnd(18)} ${dim(bits.join(" "))}`);
    }
  }
  out(dim("\n  vyre kit deploy <kit> puts one on this Space"));
  return 0;
}

/**
 * A Kit of the library: propose it, and the Kit it needs first, each for the owner's yes.
 * @param {string} id the Kit's id
 */
async function deployLibrary(id) {
  const lib = await call("flows.kit.library", {});
  if (lib.error) return failTool(lib.error);
  const kits = /** @type {any[]} */ (lib.data.kits);
  const have = await call("flows.kit.list", {});
  const rows = /** @type {any[]} */ (have.error ? [] : (have.data.kits || have.data || []));
  const installed = new Map(rows.filter((/** @type {any} */ k) => !k.status || k.status === "installed").map((/** @type {any} */ k) => [k.id ?? k.kit_id, k]));
  const want = kits.find(k => k.id === id);
  if (!want) { out(beacon(`  no Kit ${id}`) + dim(` · ${kits.map(k => k.id).join(", ") || "this build ships none"}, or give the file or address of a Kit`)); return 1; }
  /** @type {{ kit: string, ok: boolean, said: string, task?: string }[]} */ const steps = [];
  for (const k of [...want.requires.map((/** @type {string} */ r) => kits.find(x => x.id === r)).filter(Boolean), want]) {
    const have1 = installed.get(k.id);
    if (have1 && Number(have1.version) >= Number(k.version)) { steps.push({ kit: k.id, ok: true, said: `already installed (version ${have1.version})` }); continue; }
    const got = await call("flows.kit.library.get", { id: k.id });
    if (got.error) { steps.push({ kit: k.id, ok: false, said: String(got.error.message || got.error.code) }); break; }
    const r = await call("flows.kit.propose", { kit: got.data.kit });
    if (r.error) { steps.push({ kit: k.id, ok: false, said: String(r.error.message || r.error.code) }); break; }
    const d = r.data;
    steps.push(d && d.ok === false ? { kit: k.id, ok: false, said: `not proposed: ${(d.errors || []).map((/** @type {any} */ e) => e.message).join("; ")}` } : { kit: k.id, ok: true, said: "its card is waiting for your yes", task: d && d.task });
    if (d && d.ok === false) break;
  }
  const failed = steps.some(r => !r.ok);
  if (json()) { emit({ kit: id, steps }); return failed ? 1 : 0; }
  for (const r of steps) out(`  ${r.ok ? signal("waiting") : beacon("failed")} ${r.kit}: ${dim(r.said)}`);
  if (!failed && steps.some(r => /waiting/.test(r.said))) out(dim("  next: vyre needs"));
  return failed ? 1 : 0;
}

/**
 * A Kit from a file on this computer or from an https address: read it here, propose it, and leave
 * the owner's yes as it is. Nothing installs until they say yes, and a refusal is said as it is and
 * not tried again. The token of a private address is used for that one request and never kept.
 * @param {string} what the file path or the address
 * @param {string} token a vault://item/field reference, or none
 */
async function deployFrom(what, token) {
  let ref = "";
  if (token) {
    const parsed = tokenRef(token);
    if (!parsed.ok) return usage(parsed.why, "vyre kit deploy <https-address> --token vault://item/field");
    ref = parsed.ref;
  }
  // A token is for an address. A file needs none, and saying so is better than silence.
  const checked = checkSource(what);
  const note = ref && checked.ok && checked.kind === "file" ? "a token is only used for an address: this Kit is in a file" : "";
  // The token is asked for only when the source is an address: a file needs no key.
  const got = await readKit(what, { token: ref ? async () => vaultToken(ref) : undefined });
  if (!got.ok) return notRead(got);
  const r = await call("flows.kit.propose", { kit: got.kit, source: got.source });
  if (r.error) return failTool(r.error);
  const d = r.data;
  const id = String((d && d.card && d.card.kit && d.card.kit.id) || (got.kit && got.kit.id) || "the Kit");
  const step = d && d.ok === false
    ? { kit: id, ok: false, said: `not proposed: ${(d.errors || []).map((/** @type {any} */ e) => e.message).join("; ")}` }
    : { kit: id, ok: true, said: "its card is waiting for your yes", task: d && d.task };
  if (json()) { emit({ kit: id, source: got.source, steps: [step], ...(note ? { note } : {}) }); return step.ok ? 0 : 1; }
  out(`  ${step.ok ? signal("waiting") : beacon("failed")} ${id}: ${dim(step.said)}`);
  if (note) out(dim(`  ${note}`));
  if (step.ok) out(dim("  next: vyre needs"));
  return step.ok ? 0 : 1;
}

/**
 * A source that could not be read, said as it is: a wrong shape is a usage mistake, a missing file
 * or an address that answered nothing is a failure, and an address that did not answer is out of
 * reach.
 * @param {{ why: string, code?: string }} got
 */
function notRead(got) {
  if (got.code === "bad_input") return usage(got.why, "vyre kit deploy <file-or-https-address>");
  if (got.code === "too_large") return fail(got.why, { code: "too_large", exit: EXIT.FAILED, next: "give a Kit that is smaller" });
  if (got.code === "unreachable") return fail(got.why, { code: "unreachable", exit: EXIT.UNREACHABLE, next: "check the address and try again" });
  if (got.code === "locked") return fail(got.why, { code: "locked", exit: exitFor({ code: "locked" }), next: nextFor({ code: "locked" }) });
  return fail(got.why, { code: got.code || "failed", exit: EXIT.FAILED });
}
