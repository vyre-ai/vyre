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
// On a Mac it checks vyred, who is signed in, the link to each space, the path to the server (direct or
// through the relay), the relay, the server's door, storage and the clock (all from network.wink.status),
// then what only the box knows through the link, the Capsule, whether every module on THIS machine
// started, and the install. On a box it checks the same things from the box's side.
//
// --json: { ok, role, ms, checks: [{ id, label, ok, detail?, fix? }] }. --view draws the same
// checks live: a checks frame as each one answers (data null), then the whole result as the last.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { request, call } from "../../daemon/client.js";
import { REPO } from "../../daemon/index.js";
import { label as buildLabel } from "../../daemon/build.js";
import * as config from "../../config/index.js";
import { appPath as capsuleApp } from "./capsule-native.js";
import { shadows } from "../shadow.js";
import { progressLine } from "../../recall/progress.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { INSTALL } from "../brand.js";
import { json, emit, EXIT, viewing } from "../kit.js";
import { execFileSync, spawnSync } from "node:child_process";
import { parsePmset, powerDrift, pmsetArgs, fileVault, PMSET } from "../../vyre-core/online.js";

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
 *   capsuleApps?: string[], size?: () => { bytes: number, files: number }, role?: string, box?: string | null,
 *   modules?: () => Promise<{ data?: any, error?: any }>,
 *   path?: () => ReturnType<typeof shadows>, onCheck?: (i: number, c: Check | null) => void }} [deps] onCheck hears each
 *   check as it answers, by its place in IDS (null: it does not apply here)
 * @returns {Promise<{ role: string, checks: Check[], ms: number }>}
 */
export async function diagnose(deps = {}) {
  const t0 = Date.now();
  const tool = deps.tool || ((name, input = {}) => call(name, input, { timeout: STEP_MS }));
  const health = deps.health || (async () => { const r = await request("GET", "/v1/health", undefined, { timeout: STEP_MS }); return r.error ? null : r.data; });
  const role = deps.role || config.load().role || "local";
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

  // --------------------------------------------------------------- the network, as the Wink node sees it
  // One read, network.wink.status, shared by the seven checks below. Read-only; a machine whose vyred has no network tools answers "?" lines, never a cross.
  const net = up ? within(tool("network.wink.status"), STEP_MS, () => ({ error: { message: "no answer" } })) : Promise.resolve(null);
  const view = net.then(r => (r && r.data && !r.error ? r.data : null));
  const noAnswer = (id, label) => unknown(id, label, up ? "did not answer in 2 s" : "vyred is not running");
  const spaces = view.then(d => (d && Array.isArray(d.spaces) ? d.spaces : []));

  const identity = view.then(d => {
    const label = "Signed in to Vyre";
    if (!up) return unknown("identity", label, "vyred is not running", "vyre up");
    if (!d) return noAnswer("identity", label);
    if (d.identity && d.identity.signedIn === null) return unknown("identity", label, "could not check");
    if (!d.identity || d.identity.signedIn === false) return failed("identity", label, "this computer is not signed in", "open the Vyre app and sign in, or run: vyre up");
    const n = d.identity.devices;
    return pass("identity", label, [d.identity.name, typeof n === "number" ? `${n} device${n === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ") || null);
  });

  const spaceLink = Promise.all([view, spaces]).then(([d, list]) => {
    if (!d) return noAnswer("space-link", "Link to your space");
    if (!list.length) return unknown("space-link", "Link to your space", "this computer has not joined a space", "vyre up");
    return list.map(sp => {
      const label = `Link to ${sp.name || sp.id}`;
      if (sp.relayOnly || (d.otherVpn && sp.path === "relay")) return unknown("space-link", label, "using the relay, because another VPN is running here");
      if (sp.state === "connected" || sp.state === "relayed") return pass("space-link", label, `up, ${sp.peers} other device${sp.peers === 1 ? "" : "s"} seen`);
      if (sp.state === "joining") return unknown("space-link", label, "still coming up");
      const gone = /unreachable|no path|did not answer|no internet/i.test(String(sp.why || ""));
      return failed("space-link", label, "down", gone ? "the server is off or has no internet" : "on the server that hosts it, run: vyre doctor");
    });
  });

  const pathCheck = Promise.all([view, spaces]).then(([d, list]) => {
    const label = "Path to your server";
    if (!d) return noAnswer("path", label);
    if (role === "box" && !list.some(sp => sp.path)) return null;
    const sp = list.find(x => x.path) || list.find(x => !x.door || !x.door.listening);
    if (!sp) return unknown("path", label, "no server paired yet", "run: vyre up");
    const ms = typeof sp.latencyMs === "number" ? `${sp.latencyMs} ms` : "";
    if (sp.state === "connected" || sp.state === "relayed") return pass("path", label, sp.path === "direct" ? ["direct", ms].filter(Boolean).join(", ") : `through the relay${ms ? ", " + ms : ""} (no direct path yet)`);
    return failed("path", label, "none", "check this computer's internet connection");
  });

  const relayCheck = view.then(d => {
    const label = "Relay";
    if (!d) return noAnswer("relay", label);
    const r = d.relay || {};
    if (r.enabled === false) return unknown("relay", label, "turned off on this server");
    if (r.reachable === true) return pass("relay", label, `answering${typeof r.latencyMs === "number" ? ", " + r.latencyMs + " ms" : ""}`);
    if (r.reachable === false) return failed("relay", label, "not answering", "a firewall may block outbound HTTPS (port 443); the relay is the path that always works");
    return unknown("relay", label, "could not check");
  });

  const door = spaces.then(async list => {
    const label = "Server door";
    if (!(await view)) return noAnswer("door", label);
    if (list.some(sp => sp.door && sp.door.refused)) return failed("door", label, "refused this device (not on the list)", "ask an owner to add it, or pair again with: vyre up");
    const hosted = list.filter(sp => sp.door && sp.door.listening);
    if (hosted.length) return pass("door", label, "accepting linked devices");
    if (role === "box") return failed("door", label, "not listening", "on the server: restart Vyre");
    return unknown("door", label, "only a server has one");
  });

  const storage = view.then(d => {
    if (!d) return null;
    return (d.storage || []).map(x => {
      const label = `Storage: ${x.name || x.id}`;
      if (x.reachable) {
        const gb = typeof x.free === "number" ? x.free / 1e9 : null;
        return pass("storage", label, gb === null ? "reachable" : `reachable, ${gb >= 1000 ? (gb / 1000).toFixed(1) + " TB" : Math.round(gb) + " GB"} free`);
      }
      return failed("storage", label, "not reachable", "check the access details saved for it in the vault");
    });
  }).then(a => (a && a.length ? a : null));

  const clock = view.then(d => {
    const label = "Clock";
    if (!d) return noAnswer("clock", label);
    const ms = d.clock && d.clock.skewMs;
    if (typeof ms !== "number") return unknown("clock", label, "could not reach the relay to compare");
    const s = Math.abs(ms) / 1000;
    if (s <= 2) return pass("clock", label, "within 2 s of the relay");
    if (s <= 30) return pass("clock", label, `${Math.round(s)} s from the relay's, close enough`);
    return failed("clock", label, `${Math.round(s)} s off, so pairing and device lists will be refused`, "turn on automatic date and time in this computer's settings");
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
    if (first) return failed("vyre-on-path", labelPath, `${tilde(first.path)} comes first on PATH${first.target !== first.path ? " (" + tilde(first.target) + ")" : ""}`, `rm ${tilde(first.path)}, then hash -r`);
    if (s.others.length) return failed("vyre-on-path", labelPath, `another vyre is also on PATH: ${tilde(s.others[0].path)}; a shell that remembers it runs that one`, `rm ${tilde(s.others[0].path)}, then hash -r`);
    if (!s.ours) return unknown("vyre-on-path", labelPath, "this vyre is not on PATH (run through a full path?)");
    return pass("vyre-on-path", labelPath);
  });

  // Every module started: a manifest that under- or over-declares a tool or event fails that
  // module alone, silently to a person just watching Chat or the Deck (every other module still
  // loads, so "no such tool" from something that quietly never registered is the only symptom
  // otherwise) - the gotcha that cost tailnet real time shipping relay.pair.ticket (team/archive/work-journals/
  // tailnet.md, 28 Sep 2026). vyred's own log already names the module and the exact manifest key
  // (core/modules/index.js's startOne), but nothing surfaced it here until now, and the log is
  // the only place it was loud. /v1/modules is this machine's own registry (box or Mac, whichever
  // `vyre doctor` runs on), same status() the module never disappears from.
  const modules = up ? within((deps.modules || (() => request("GET", "/v1/modules", undefined, { timeout: STEP_MS })))(), STEP_MS, () => ({ error: { message: "no answer" } })).then(r => {
    const labelMods = "Every module started";
    if (r.error || !Array.isArray(r.data)) return unknown("modules", labelMods, r.error ? r.error.message : "/v1/modules did not answer");
    const bad = r.data.filter(m => m.state === "failed" || m.state === "invalid");
    if (!bad.length) return pass("modules", labelMods, `${r.data.filter(m => m.state === "running").length} running`);
    const names = bad.map(m => m.name).join(", ");
    return failed("modules", labelMods, `${bad.length === 1 ? bad[0].name : `${bad.length} modules (${names})`}: ${bad[0].error}`, "check vyred's log for the module and manifest key it names");
  }) : Promise.resolve(unknown("modules", "Every module started", "vyred is not running", "vyre up"));

  // Recall's index: keyword search works at once; meaning trickles in at low priority.
  const recall = up ? within(tool("recall.status"), STEP_MS, () => ({ error: { message: "no answer" } })).then(r => {
    if (r.error || !r.data) return unknown("recall", "Search", `recall.status did not answer${r.error ? ": " + r.error.message : ""}`);
    const line = progressLine(r.data);
    return pass("recall", "Search", line || `${Number(r.data.sessions || 0).toLocaleString("en-US")} sessions indexed${r.data.vectors && r.data.vectors.ready ? ", by meaning too" : ""}`);
  }) : Promise.resolve(null);

  // A Mac that is a server (the system service is installed) must come back by itself: after a power cut it boots, it never sleeps (vyre-core/online.js). Not applicable anywhere else.
  const sysRun = deps.sysRun || ((cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 1200, stdio: ["ignore", "pipe", "ignore"] }));
  const macServer = (deps.platform || process.platform) === "darwin" && fs.existsSync(deps.coreJson || "/Library/Application Support/Vyre/core.json");
  const alwaysOn = !macServer ? Promise.resolve(null) : (async () => {
    const label = "Comes back after a power cut";
    let have;
    try { have = parsePmset(sysRun(PMSET, ["-g"])); } catch { return unknown("always-on", label, "pmset did not answer"); }
    const drift = powerDrift(have);
    return drift.length
      ? failed("always-on", label, drift.map(d => `${d.key} is ${d.have}, should be ${d.want}`).join(", "), "vyre doctor --repair (asks for your Mac password once)")
      : pass("always-on", label, "starts when power returns, never sleeps");
  })();
  const vault = !macServer ? Promise.resolve(null) : (async () => {
    const label = "FileVault";
    const f = fileVault(sysRun);
    if (f === "on") return failed("filevault", label, "on: after a power cut this Mac waits at the login window and nothing runs", "turn FileVault off in System Settings, Privacy & Security (Vyre does not change it), or keep it and accept that a power cut leaves this server waiting for someone to sign in");
    return f === "off" ? pass("filevault", label, "off") : unknown("filevault", label, "fdesetup did not say");
  })();

  const all = [vyred, identity, spaceLink, pathCheck, relayCheck, door, storage, clock, paired, passkey, claude, capsule, modules, recall, onPath, size, alwaysOn, vault];
  const left = Math.max(100, BUDGET_MS - (Date.now() - t0));
  const named = (c, i) => c && c.id === "?" ? { ...c, id: IDS[i], label: LABELS[i], detail: `no answer in ${BUDGET_MS / 1000} s` } : c;
  // A check that has one line per space or per storage device answers a list; onCheck hears the worst of it, the result has every line.
  const worst = list => list.find(c => c.ok === false) || list.find(c => c.ok === null) || list[0];
  const results = await Promise.all(all.map((p, i) => within(p, left, () => ({ id: "?", label: "", ok: null, detail: "timed out" }))
    .then(c => { const n = Array.isArray(c) ? c : named(c, i); if (deps.onCheck) deps.onCheck(i, Array.isArray(n) ? (n.length ? worst(n) : null) : n || null); return n; })));
  const checks = results.flat().filter(Boolean);
  return { role, checks: /** @type {Check[]} */ (checks), ms: Date.now() - t0 };
}

/** Every check's id and short label, in the order diagnose runs them. */
export const IDS = ["vyred", "identity", "space-link", "path", "relay", "door", "storage", "clock", "paired", "passkey", "claude", "capsule", "modules", "recall", "vyre-on-path", "install", "always-on", "filevault"];
const LABELS = ["vyred", "Signed in to Vyre", "Link to your space", "Path to your server", "Relay", "Server door", "Storage", "Clock", "Paired", "Passkey", "Claude on the box", "The Capsule", "Every module started", "Search", "The vyre on PATH", "Install size", "Comes back after a power cut", "FileVault"];

/**
 * A check as a checks frame's item: ok, failed or unknown, the detail and the fix in the note.
 * @param {Check} c @returns {{ id: string, label: string, state: "ok"|"failed"|"unknown", note?: string }}
 */
export function item(c) {
  const note = [c.detail, c.fix && c.ok !== true ? `next: ${c.fix}` : ""].filter(Boolean).join(" · ");
  return { id: c.id, label: c.label, state: c.ok === true ? "ok" : c.ok === false ? "failed" : "unknown", ...(note ? { note } : {}) };
}

/** One check as terminal lines. */
export function lines(/** @type {Check} */ c) {
  const mark = c.ok === true ? signal("✓") : c.ok === false ? beacon("✗") : dim("?");
  const head = `  ${mark} ${c.ok === false ? bold(c.label) : c.label}${c.detail ? dim(" · " + c.detail) : ""}`;
  return c.fix && c.ok !== true ? [head, "      " + (c.ok === false ? c.fix : dim(c.fix))] : [head];
}

/** --view: a checks frame each time a check answers, then the result with its checks as the last frame. */
async function live() {
  /** @type {(Check | null | undefined)[]} */
  const known = IDS.map(() => undefined);
  const items = () => IDS.map((id, i) => known[i] === undefined ? { id, label: LABELS[i], state: /** @type {const} */ ("wait") } : known[i] ? item(/** @type {Check} */ (known[i])) : null).filter(Boolean);
  emit(null, { kind: "checks", title: "Checking", items: items() });
  const r = await diagnose({ onCheck: (i, c) => { known[i] = c; emit(null, { kind: "checks", title: "Checking", items: items() }); } });
  const ok = r.checks.every(c => c.ok !== false);
  const bad = r.checks.filter(c => c.ok === false).length;
  emit({ ok, role: r.role, ms: r.ms, checks: r.checks }, { kind: "checks", title: `${bad ? `${bad} to fix` : "Nothing to fix"} · checked in ${(r.ms / 1000).toFixed(1)} s`, items: r.checks.map(item) });
  return ok ? EXIT.OK : EXIT.FAILED;
}

export default {
  name: "doctor", order: 12, usage: "vyre doctor [--json] [--repair]",
  summary: "check Vyre, your link, the relay, your devices, passkey, pairing, Claude and the Capsule, and say what to fix",
  help: "Read-only and under 2 s. ✓ passed, ✗ failed (the line under it is what to do), ? could not be checked.\nExit 0 when nothing failed, 1 when something did. --json: { ok, role, checks: [{ id, label, ok, detail, fix }] }.",
  /** @param {string[]} args */
  async run(args = []) {
    if (viewing()) return live();
    let r = await diagnose();
    // --repair: put a Mac server's power settings right (root: one password prompt). FileVault is never changed by Vyre; its line says what to do.
    if (args.includes("--repair")) {
      if (r.checks.some(c => c.id === "always-on" && c.ok === false)) {
        out(dim("  setting this Mac to start after a power cut and never sleep (sudo pmset)..."));
        const rc = spawnSync("/usr/bin/sudo", [PMSET, ...pmsetArgs()], { stdio: "inherit" });
        if (rc.status !== 0) out(dim("  the power settings were not changed"));
        r = await diagnose();
      } else out(dim("  nothing to repair that Vyre may change"));
    }
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
