// @ts-check
// `vyre doctor`: one command that checks everything a first night with Vyre trips on, and says
// exactly what to do about each. Every line is a check that passed (✓), failed (✗, with the one
// thing to do next), or could not be checked (?, with why). --json gives the same list for the
// Deck and the docs.
//
// It is read-only: it never signs anything in, pairs, mints a link or opens a dialog. It is fast:
// every check runs at once, each has its own timeout, and the whole run is cut off at 2 s, so a
// box that does not answer is a line that says so, not a hang.
//
// On a Mac it checks vyred, Tailscale here, the box (through Tailscale, its address, and through
// the link for what only the box knows), the phone, the Capsule and the install. On a box it
// checks the same things from the box's side.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dns from "node:dns/promises";
import { request, call } from "../../daemon/client.js";
import { REPO } from "../../daemon/index.js";
import { label as buildLabel } from "../../daemon/build.js";
import * as config from "../../config/index.js";
import { status as tailscaleStatus, probe } from "../tailnet.js";
import { appPath as capsuleApp } from "./capsule-native.js";
import { shadows } from "../shadow.js";
import { progressLine } from "../../recall/progress.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { INSTALL } from "../brand.js";
import { json, emit, EXIT } from "../kit.js";

/** The whole run's budget, and one check's. */
export const BUDGET_MS = 2000;
const STEP_MS = 1500;

/**
 * @typedef {{ id: string, label: string, ok: boolean | null, detail?: string, fix?: string }} Check
 * ok: true passed, false failed (fix says what to do), null could not be checked (detail says why).
 */

const pass = (id, label, detail) => ({ id, label, ok: true, ...(detail ? { detail } : {}) });
const failed = (id, label, detail, fix) => ({ id, label, ok: false, ...(detail ? { detail } : {}), fix });
const unknown = (id, label, detail, fix) => ({ id, label, ok: null, detail, ...(fix ? { fix } : {}) });

/** A promise, or `fallback` after `ms`. */
function within(p, ms, fallback) {
  let t;
  return Promise.race([Promise.resolve(p).catch(e => fallback(e)), new Promise(r => { t = setTimeout(() => r(fallback(null)), ms); })])
    .finally(() => clearTimeout(t));
}

const host = address => { try { return new URL(address).hostname; } catch { return ""; } };

/** How big this install is on disk, in bytes, and how many files. Stops early past a cap. */
export function installSize(dir = REPO, cap = 200_000) {
  let bytes = 0, files = 0;
  const walk = d => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (files > cap) return;
      const p = path.join(d, e.name);
      // A checkout's .git and a dev node_modules are not what npm installed.
      if (e.isDirectory()) { if (e.name !== ".git") walk(p); }
      else if (e.isFile()) { try { bytes += fs.statSync(p).size; files++; } catch {} }
    }
  };
  walk(dir);
  return { bytes, files };
}

/**
 * Every check, given how to reach things. Pure of the terminal, so a test gives fakes.
 * @param {{ health?: () => Promise<any>, tool?: (name: string, input?: any) => Promise<{ data?: any, error?: any }>,
 *   tailscale?: () => Promise<any>, resolve?: (h: string) => Promise<any>, probe?: (a: string, ms: number) => Promise<any>,
 *   capsuleApps?: string[], size?: () => { bytes: number, files: number }, role?: string, box?: string | null,
 *   path?: () => ReturnType<typeof shadows> }} [deps]
 * @returns {Promise<{ role: string, checks: Check[], ms: number }>}
 */
export async function diagnose(deps = {}) {
  const t0 = Date.now();
  const tool = deps.tool || ((name, input = {}) => call(name, input, { timeout: STEP_MS }));
  const health = deps.health || (async () => { const r = await request("GET", "/v1/health", undefined, { timeout: STEP_MS }); return r.error ? null : r.data; });
  const role = deps.role || config.load().role || "local";
  const ts = within((deps.tailscale || (() => tailscaleStatus(process.env, { timeout: STEP_MS })))(), STEP_MS, () => null);
  const h = within(health(), STEP_MS, () => null);

  // --------------------------------------------------------------- vyred
  const vyred = h.then(d => d
    ? pass("vyred", "vyred is running", buildLabel({ version: d.version, commit: d.commit ?? null, dirty: d.dirty ?? null }))
    : failed("vyred", "vyred is not running", null, "vyre up"));

  // Box-only facts come through vyred. On a Mac they come through the link, from the box.
  const remote = (name, input = {}) => role === "box" ? tool(name, input) : tool("link.call", { tool: name, input });
  const up = await h;
  const linkStatus = role === "box" || !up ? Promise.resolve(null) : within(tool("link.status"), STEP_MS, () => ({ error: { message: "no answer" } }));
  const names = role === "box" && up ? within(tool("names.status"), STEP_MS, () => ({ error: { message: "no answer" } })) : Promise.resolve(null);
  const box = (async () => {
    if (role === "box") { const n = await names; return n && n.data ? n.data.address || null : null; }
    const l = await linkStatus;
    return (l && l.data && l.data.box && l.data.box.address) || deps.box || config.load().network?.box || null;
  })();

  // --------------------------------------------------------------- Tailscale here
  const here = role === "box" ? "this box" : "this Mac";
  const tailscale = ts.then(t => {
    if (!t) return unknown("tailscale", `Tailscale on ${here}`, "tailscale status did not answer in time", "open Tailscale and check it is running");
    if (!t.installed) return failed("tailscale", `Tailscale on ${here}`, "not installed", "install it: https://tailscale.com/download");
    if (!t.running) return failed("tailscale", `Tailscale on ${here}`, t.why || t.backend || "not running", "open Tailscale and sign in");
    return pass("tailscale", `Tailscale on ${here}`, t.login ? `signed in as ${t.login}` : "running");
  });
  const magic = ts.then(t => {
    if (!t || !t.running) return unknown("magicdns", "MagicDNS and HTTPS on the tailnet", "Tailscale is not running here");
    const off = [t.magicDNS === false ? "MagicDNS" : "", !t.certDomains?.length ? "HTTPS certificates" : ""].filter(Boolean);
    if (off.length) return failed("magicdns", "MagicDNS and HTTPS on the tailnet", `${off.join(" and ")} off`, "turn them on: https://login.tailscale.com/admin/dns");
    return pass("magicdns", "MagicDNS and HTTPS on the tailnet", t.certDomains[0]);
  });

  // --------------------------------------------------------------- the box, over the tailnet
  const boxTailscale = Promise.all([ts, box]).then(([t, address]) => {
    const labelBox = "Tailscale on the box, same account";
    if (role === "box") return null;
    if (!address) return unknown("tailscale-box", labelBox, "this Mac knows no box yet", "vyre up --connect <your box's address>");
    if (!t || !t.running) return unknown("tailscale-box", labelBox, "Tailscale is not running on this Mac");
    const name = host(address);
    const peer = t.peers.find(p => p.dnsName === name || name.startsWith(p.dnsName.split(".")[0] + "."));
    if (!peer) return failed("tailscale-box", labelBox, `${name} is not on this Mac's tailnet`, `sign the box in to Tailscale as ${t.login || "you"}, or share it with you`);
    if (!peer.online) return failed("tailscale-box", labelBox, `${peer.hostName} is offline on the tailnet`, "on the box: sudo tailscale up");
    if (!peer.tagged && t.userId && peer.userId !== t.userId) return failed("tailscale-box", labelBox, `${peer.hostName} is signed in to another account`, `on the box: sudo tailscale up, and sign in as ${t.login || "you"}`);
    return pass("tailscale-box", labelBox, `${peer.hostName}${peer.tagged ? ", a tagged node" : ""}`);
  });
  const phone = ts.then(t => {
    const labelPhone = "Your phone on the tailnet";
    if (!t || !t.running) return unknown("phone", labelPhone, `Tailscale is not running on ${here}`);
    const mine = t.peers.filter(p => /^(ios|android)$/i.test(p.os) && (!t.userId || p.userId === t.userId));
    if (!mine.length) return failed("phone", labelPhone, "no phone signed in to your tailnet", `install Tailscale on your phone and sign in${t.login ? " as " + t.login : ""}`);
    const on = mine.find(p => p.online);
    if (!on) return failed("phone", labelPhone, `${mine[0].hostName} is offline`, "open Tailscale on your phone and turn it on");
    return pass("phone", labelPhone, on.hostName);
  });
  const address = box.then(async a => {
    const labelAddr = "The box's address answers";
    if (!a) return role === "box"
      ? failed("address", labelAddr, "this box has no address yet", "vyre name")
      : unknown("address", labelAddr, "this Mac knows no box yet", "vyre up --connect <your box's address>");
    if (role === "box") {
      // A box cannot ask its own address (its listener refuses itself, ADR 0002): names.status says.
      const n = await names;
      const phase = n && n.data && n.data.phase;
      return phase === "serving" ? pass("address", labelAddr, a) : failed("address", labelAddr, `${a} is ${phase || "not serving"}`, "vyre name");
    }
    const name = host(a);
    const found = await within((deps.resolve || (x => dns.lookup(x)))(name), STEP_MS, () => null);
    if (!found) return failed("address", labelAddr, `${name} does not resolve`, "turn on MagicDNS on this Mac: open Tailscale, Settings, Use Tailscale DNS");
    const hh = await within((deps.probe || probe)(a, STEP_MS), STEP_MS, () => null);
    if (!hh) return failed("address", labelAddr, `${a} does not answer`, "on the box: vyre status, then vyre up");
    return pass("address", labelAddr, `${a} · ${buildLabel({ version: hh.version, commit: hh.commit ?? null, dirty: hh.dirty ?? null })}`);
  });

  // --------------------------------------------------------------- what only the box knows
  const paired = role === "box"
    ? (up ? within(tool("link.peers"), STEP_MS, () => null) : Promise.resolve(null)).then(r => {
        const n = r && r.data ? (Array.isArray(r.data) ? r.data : r.data.peers || []).length : null;
        if (n === null) return unknown("paired", "A Mac is paired", up ? "link.peers did not answer" : "vyred is not running");
        return n ? pass("paired", "A Mac is paired", `${n} Mac${n === 1 ? "" : "s"}`) : failed("paired", "A Mac is paired", "none yet", "on your Mac: vyre up");
      })
    : linkStatus.then(l => {
        if (!up) return unknown("paired", "This Mac is paired", "vyred is not running", "vyre up");
        const d = l && l.data;
        if (!d) return unknown("paired", "This Mac is paired", (l && l.error && l.error.message) || "link.status did not answer");
        if (!d.linked) return failed("paired", "This Mac is paired", d.pending ? `waiting for approval, code ${d.pending.code}` : "not paired", d.pending ? `on the box: vyre link approve ${d.pending.code}` : "vyre up");
        return d.reachable ? pass("paired", "This Mac is paired", d.box.name || host(d.box.address)) : failed("paired", "This Mac is paired", "paired, but the box is not answering", "check the box is on: vyre status on the box");
      });
  const linked = paired.then(p => role === "box" || p.ok === true);
  const passkey = Promise.all([box, linked]).then(async ([a, ok]) => {
    const labelKey = "A passkey for the box's address";
    if (!a) return unknown("passkey", labelKey, "no box address yet");
    if (!up) return unknown("passkey", labelKey, "vyred is not running", "vyre up");
    if (!ok) return unknown("passkey", labelKey, "the box is not reachable from this Mac");
    const r = await within(remote("presence.keys"), STEP_MS, () => ({ error: { message: "no answer" } }));
    if (r.error) return unknown("passkey", labelKey, `the box did not say: ${r.error.message}`);
    const rp = host(a);
    const keys = (Array.isArray(r.data) ? r.data : []).filter(k => k.kind === "passkey");
    if (keys.some(k => String(k.rp_id || "").toLowerCase() === rp.toLowerCase())) return pass("passkey", labelKey, rp);
    const fix = "on the box: vyre up, then open the passkey link it prints from your phone";
    return failed("passkey", labelKey, keys.length ? `passkeys exist, but none for ${rp}` : "none enrolled", fix);
  });
  const claude = Promise.all([linked]).then(async ([ok]) => {
    const labelClaude = "Claude is signed in on the box";
    if (!up) return unknown("claude", labelClaude, "vyred is not running", "vyre up");
    if (!ok) return unknown("claude", labelClaude, "the box is not reachable from this Mac");
    const r = await within(remote("onboard.status"), STEP_MS, () => ({ error: { message: "no answer" } }));
    // onboard.status keeps each step's facts under detail.
    const c = r.data && ((r.data.detail && r.data.detail.claude) || r.data.claude);
    if (r.error || !c) return unknown("claude", labelClaude, `the box did not say${r.error ? ": " + r.error.message : ""}`);
    if (!c.installed) return failed("claude", labelClaude, "Claude Code is not installed on the box", "reinstall the box: curl -fsSL https://vyre.run/box | sh");
    if (!c.signedIn) return failed("claude", labelClaude, "not signed in", "open the box's address, Settings, Setup, Claude");
    return pass("claude", labelClaude, c.via === "api-key" ? "with an API key" : "with your subscription");
  });

  // --------------------------------------------------------------- this machine
  const capsule = role === "box" || process.platform !== "darwin" ? Promise.resolve(null) : (async () => {
    const labelCap = "The Capsule";
    // The native app, built on this Mac into the Vyre home (capsule-native.js).
    const app = (deps.capsuleApps || [capsuleApp(config.paths().root)]).find(p => fs.existsSync(p));
    if (!app) return failed("capsule", labelCap, "not installed", "vyre capsule install");
    // What macOS allows is known to the app itself (TCC holds Vyre.app responsible); it reports
    // it as capsule.hotkey. A Capsule that has not reported yet is "?" rather than a guess.
    const r = up ? await within(request("GET", "/v1/events?type=capsule.hotkey&limit=1000", undefined, { timeout: STEP_MS }), STEP_MS, () => null) : null;
    const last = r && Array.isArray(r.data) ? r.data[r.data.length - 1] : null;
    if (!last) return unknown("capsule", labelCap, `installed at ${app.replace(os.homedir(), "~")}; permissions not reported yet`, "open it: Control twice, or vyre capsule");
    return last.payload && last.payload.ok
      ? pass("capsule", labelCap, "installed, Control twice works")
      : failed("capsule", labelCap, (last.payload && last.payload.message) || "Control twice is off", "System Settings, Privacy & Security, Input Monitoring: turn on Vyre");
  })();
  const size = Promise.resolve().then(() => {
    const s = (deps.size || installSize)();
    const mb = s.bytes / 1e6;
    return mb > 50
      ? failed("install", "Install size", `${mb.toFixed(0)} MB in ${s.files} files`, `${INSTALL} (the search model lives in ~/.vyre now)`)
      : pass("install", "Install size", `${mb.toFixed(1)} MB`);
  });

  // Another `vyre` on PATH: an old prototype answered a user's first `vyre up` instead of this one.
  const onPath = Promise.resolve().then(() => {
    const s = (deps.path || shadows)();
    const labelPath = "This is the vyre your shell runs";
    const tilde = p => p.replace(os.homedir(), "~");
    const first = s.others.find(o => o.first);
    if (first) return failed("path", labelPath, `${tilde(first.path)} comes first on PATH${first.target !== first.path ? " (" + tilde(first.target) + ")" : ""}`, `rm ${tilde(first.path)}, then hash -r`);
    if (s.others.length) return failed("path", labelPath, `another vyre is also on PATH: ${tilde(s.others[0].path)}; a shell that remembers it runs that one`, `rm ${tilde(s.others[0].path)}, then hash -r`);
    if (!s.ours) return unknown("path", labelPath, "this vyre is not on PATH (run through a full path?)");
    return pass("path", labelPath);
  });

  // Recall's index: keyword search works at once; meaning trickles in at low priority.
  const recall = up ? within(tool("recall.status"), STEP_MS, () => ({ error: { message: "no answer" } })).then(r => {
    if (r.error || !r.data) return unknown("recall", "Search", `recall.status did not answer${r.error ? ": " + r.error.message : ""}`);
    const line = progressLine(r.data);
    return pass("recall", "Search", line || `${Number(r.data.sessions || 0).toLocaleString("en-US")} sessions indexed${r.data.vectors && r.data.vectors.ready ? ", by meaning too" : ""}`);
  }) : Promise.resolve(null);

  const all = [vyred, tailscale, magic, boxTailscale, phone, address, paired, passkey, claude, capsule, recall, onPath, size];
  const left = Math.max(100, BUDGET_MS - (Date.now() - t0));
  const results = await Promise.all(all.map(p => within(p, left, () => ({ id: "?", label: "", ok: null, detail: "timed out" }))));
  const labels = ["vyred", "Tailscale", "MagicDNS and HTTPS", "Tailscale on the box", "Your phone", "The box's address", "Paired", "Passkey", "Claude on the box", "The Capsule", "Search", "The vyre on PATH", "Install size"];
  const ids = ["vyred", "tailscale", "magicdns", "tailscale-box", "phone", "address", "paired", "passkey", "claude", "capsule", "recall", "path", "install"];
  const checks = results.map((c, i) => c && c.id === "?" ? { ...c, id: ids[i], label: labels[i], detail: `no answer in ${BUDGET_MS / 1000} s` } : c).filter(Boolean);
  return { role, checks: /** @type {Check[]} */ (checks), ms: Date.now() - t0 };
}

/** One check as terminal lines. */
export function lines(/** @type {Check} */ c) {
  const mark = c.ok === true ? signal("✓") : c.ok === false ? beacon("✗") : dim("?");
  const head = `  ${mark} ${c.ok === false ? bold(c.label) : c.label}${c.detail ? dim(" · " + c.detail) : ""}`;
  return c.fix && c.ok !== true ? [head, "      " + (c.ok === false ? c.fix : dim(c.fix))] : [head];
}

export default {
  name: "doctor", order: 12, usage: "vyre doctor [--json]",
  summary: "check vyred, Tailscale, the box, your phone, passkey, pairing, Claude and the Capsule, and say what to fix",
  help: "Read-only and under 2 s. ✓ passed, ✗ failed (the line under it is what to do), ? could not be checked.\nExit 0 when nothing failed, 1 when something did. --json: { ok, role, checks: [{ id, label, ok, detail, fix }] }.",
  /** @param {string[]} args */
  async run(args = []) {
    const r = await diagnose();
    const ok = r.checks.every(c => c.ok !== false);
    if (json() || args.includes("--json")) { emit({ ok, role: r.role, ms: r.ms, checks: r.checks }); return ok ? EXIT.OK : EXIT.FAILED; }
    out("");
    for (const c of r.checks) for (const l of lines(c)) out(l);
    const bad = r.checks.filter(c => c.ok === false).length;
    out("");
    out(dim(`  ${bad ? `${bad} to fix` : "nothing to fix"} · checked in ${(r.ms / 1000).toFixed(1)} s`));
    return ok ? EXIT.OK : EXIT.FAILED;
  },
};
