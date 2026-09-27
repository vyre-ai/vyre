// @ts-check
// `vyre phone`: put a phone on the box, and look after the phones it has.
//
//   vyre phone add [--iphone|--android]    the steps the Deck's "Add your phone" sheet shows: the
//                                          box's address (and a QR of it), the network, a one-time
//                                          code for the passkey, how to install, then live checks
//                                          The relay is the default: a single-use QR from
//                                          relay.pair.start, then Tailscale as an optional last step
//   vyre phone add --tailscale-only        Tailscale on the phone first, and the box's address
//   vyre phone add --android --usb         the native app over a cable (adb); --wireless for
//                                          Wireless debugging. The APK comes from the box
//   vyre phone list                        the devices that get notifications, and the passkeys
//   vyre phone remove <id>...              forget a notification device or remove a passkey
//   vyre phone test [id]                   send a test notification
//
// The phone pairs with the box, so on a box every call is local; on a Mac linked to a box the
// reads go over link.call. Minting the code and removing a passkey need presence on the box
// itself, which a Mac cannot give over the link (a passkey is the only proof the box takes from
// another machine, ADR 0004), so from a Mac those two point at the box or the Deck instead.
//
// The checks watch what the box can see, on one event stream: a new push device (push.subscribed
// triggers a read at once; push.devices is also read again every 60 s and whenever Enter is
// pressed), a new passkey (presence.enrolled), a test notification the phone showed (push.test with
// a receipt, then push.delivered carrying it back), and the app opened installed (push.seen with
// standalone). A vyred whose push.test gives no receipt still counts "the push service took it".
// HTTPS is inferred: a browser offers push and passkeys only on a secure page. Without push.seen,
// opened as an app is known only for an iPhone (Apple sends web push to Home Screen apps alone).
// Whether the phone's path is direct or relayed: the relay says so for its own devices
// (relay.devices.list path "relay"); for a phone on the tailnet the box cannot say yet.
// The relay tools (ADR 0026) are found by trying them: a box without the relay module answers
// no_such_tool, and everything here works without them.
//
// The native Android app: the box serves <box>/apps/android.json (version, sha, sha256, size,
// minSdk, file) and the APK beside it under /apps/android/. CI builds and signs it; the box and
// this command never re-sign. --usb and --wireless download it over the tailnet, check its size
// and sha256, install it with adb and open it on the pairing offer.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { call } from "../../daemon/client.js";
import * as config from "../../config/index.js";
import { callAsPerson, realIO } from "../presence.js";
import * as tailnet from "../tailnet.js";
import { qr, terminal } from "../qr.js";
import { parseSSE } from "./threads.js";
import { out, dim, bold, signal, beacon, colour } from "../style.js";
import { EXIT, json, emit, fail, failTool, usage, parse } from "../kit.js";

const USAGE = "vyre phone [add|list|remove <id>|test [id]] [--json]";
const CODE_LIFE = 10 * 60_000;
const RECHECK = 60_000;
const APPLE = /(^|\.)push\.apple\.com$/;

// ------------------------------------------------------------ where the phone pairs

/**
 * The box this terminal reaches, and how to call it. On a box: this vyred. On a Mac: the box it
 * is linked to, over link.call. Null after printing why there is none.
 * @returns {Promise<{ local: boolean, address: string|null, tool: (name: string, input?: any) => Promise<any> } | null>}
 */
export async function target() {
  const s = await call("link.status");
  if (s.error && s.error.code !== "no_such_tool") { failTool(s.error); return null; }
  const role = s.data ? s.data.role : config.load().role;
  if (role === "box") {
    const n = await call("names.status");
    const address = (n.data && n.data.address) || (config.load().network || {}).address || null;
    return { local: true, address, tool: (name, input = {}) => call(name, input) };
  }
  if (!s.data || !s.data.linked) {
    fail("this Mac is not paired with a box, and a phone pairs with the box", { next: "vyre link pair <address>, or run vyre phone add on the box" });
    return null;
  }
  return { local: false, address: s.data.box.address, tool: async (name, input = {}) => call("link.call", { tool: name, input }) };
}

const hostOf = a => { try { return new URL(String(a)).hostname; } catch { return String(a || ""); } };
/** "tail0000" from vyre.tail0000.ts.net; null for any other name. */
const tailnetOf = a => { const m = /^[^.]+\.([^.]+)\.ts\.net$/.exec(hostOf(a)); return m ? m[1] : null; };
/** A code is typed by hand: shown in fours, and the box ignores the dash. */
const spaced = c => String(c).replace(/(.{4})(?=.)/g, "$1-");
const list = r => (Array.isArray(r.data) ? r.data : []);
/** relay.devices.list's devices, or [] when the box has no relay (no_such_tool) or it fails. */
const relayDevices = r => (r && r.data && Array.isArray(r.data.devices) ? r.data.devices : []);

// ------------------------------------------------------------ the checks

/**
 * @typedef {{ id: string, label: string, state: "ok"|"wait"|"unknown"|"failed", note?: string }} Check
 * @typedef {{ devices: any[], keys: any[], relay?: any[] }} Seen
 */

/**
 * @typedef {{ device: string, sent: number, failed: number, receipt?: string|null }} Tested
 */

/**
 * The five checks from what the box has seen since the start. Pure, for tests. `delivered`: the
 * phone posted back the test's receipt (push.delivered); `standalone`: a screen said it runs as an
 * installed app (push.seen) since the start.
 * @param {Seen} before @param {Seen} now
 * @param {{ address?: string|null, tested?: Tested | null, delivered?: boolean, standalone?: boolean }} [o]
 * @returns {Check[]}
 */
export function evaluate(before, now, { address = null, tested = null, delivered = false, standalone = false } = {}) {
  const had = new Set([...before.devices.map(d => d.device), ...before.keys.map(k => k.id), ...(before.relay || []).map(r => "relay:" + r.id)]);
  const devices = now.devices.filter(d => !had.has(d.device));
  const relayed = (now.relay || []).filter(r => !had.has("relay:" + r.id));
  const keys = now.keys.filter(k => k.kind === "passkey" && !had.has(k.id));
  const any = devices.length > 0 || keys.length > 0 || relayed.length > 0;
  // path and rtt: the relay says how each device reaches the box (relay, or direct once the app
  // has linked its tailnet node) and the round trip, when it has one.
  const viaRelay = relayed.find(r => r.path === "relay" || r.path === "direct");
  // A device paired through the relay enrolls its own presence key (relay.devices.list presence).
  const keyed = keys.length > 0 || relayed.some(r => r.presence);
  const https = String(address || "").startsWith("https:");
  const apple = devices.some(d => APPLE.test(String(d.service)));
  // A receipt means the phone says when it shows the test; without one (an older vyred) the
  // push service taking it is all the box can know.
  const receipted = !tested || Boolean(tested.receipt);
  const push = !tested ? { state: "wait" }
    : tested.sent === 0 ? { state: "failed", note: `the push service refused it · vyre phone test ${tested.device}` }
    : !tested.receipt ? { state: "ok", note: "the push service took it; check the phone shows it" }
    : delivered ? { state: "ok", note: "the phone showed it" }
    : { state: "wait", note: "sent, waiting for the phone" };
  return [
    { id: "reached", label: "Phone reached the box", state: any ? "ok" : "wait",
      note: viaRelay ? `${viaRelay.path === "direct" ? "direct" : "via relay"}${viaRelay.rtt != null && Number.isFinite(Number(viaRelay.rtt)) ? ` ${Math.round(Number(viaRelay.rtt))} ms` : ""}` : any ? "direct or relayed: the box cannot tell for a tailnet phone yet" : undefined },
    { id: "https", label: "Secure address works (HTTPS)", state: any && https ? "ok" : !https && address ? "failed" : "wait",
      note: any && https ? "a browser offers notifications and passkeys only on a secure page" : !https && address ? `${address} is not https` : undefined },
    { id: "app", label: "Opened as an app, not a browser tab", state: standalone || apple ? "ok" : devices.length ? "unknown" : "wait",
      note: standalone ? "Vyre said it runs installed" : apple ? "an iPhone sends notifications only from the Home Screen app" : devices.length ? "the box cannot tell an Android app from a tab yet" : undefined },
    { id: "push", label: receipted ? "Test notification arrived" : "Test notification sent", state: /** @type {Check["state"]} */ (push.state), note: push.note },
    { id: "passkey", label: "Face ID key saved for approvals", state: keyed ? "ok" : "wait",
      note: keys.length ? String(keys[0].name || keys[0].id) : keyed ? String((relayed.find(r => r.presence) || {}).name || "through the relay") : undefined },
  ];
}

/** Everything the box can prove is done: all but "opened as an app" on Android. */
const finished = checks => checks.every(c => c.state === "ok" || (c.id === "app" && c.state === "unknown"));

const mark = c => c.state === "ok" ? signal("✓") : c.state === "failed" ? beacon("✗") : c.state === "unknown" ? dim("?") : dim("·");
const checkLine = c => `    ${mark(c)} ${c.state === "ok" ? c.label : c.state === "failed" ? beacon(c.label) : dim(c.label)}${c.note ? dim(" · " + c.note) : ""}`;

// ------------------------------------------------------------ the event stream

/** An SSE frame's event payload: the stream sends the whole event, the fields under payload. */
const payloadOf = f => { try { const e = JSON.parse(f.data || "{}"); return (e && e.payload) || e || {}; } catch { return {}; } };

/**
 * Follow some of the box's events: this vyred's stream on a box, the link's copy of the box's
 * stream on a Mac. The stream filters by one type only, so for several it takes everything and
 * keeps these here. Returns a stop function. Losing the stream only leaves the 60 s re-read.
 * @param {boolean} local @param {string[]} types @param {(type: string, payload: any) => void} onEvent
 */
function follow(local, types, onEvent) {
  const at = local ? "/v1/events/stream" : "/v1/link/events";
  const want = new Set(types);
  const filter = types.length === 1 ? `type=${encodeURIComponent(types[0])}&` : "";
  let buf = "";
  const req = http.request({ socketPath: config.paths().socket, path: `${at}?${filter}since=latest`, method: "GET",
    headers: { accept: "text/event-stream", "x-vyre-caller": "cli" } }, res => {
    if (res.statusCode !== 200) { res.resume(); return; }
    res.setEncoding("utf8");
    res.on("data", chunk => {
      const r = parseSSE(buf + chunk);
      buf = r.rest;
      for (const f of r.frames) if (f.event && want.has(f.event)) onEvent(f.event, payloadOf(f));
    });
  });
  req.on("error", () => {});
  req.end();
  return () => req.destroy();
}

// ------------------------------------------------------------ add

/**
 * @typedef {{ io?: import("../presence.js").PresenceIO, input?: NodeJS.ReadableStream | null, tty?: boolean,
 *   every?: number, life?: number, tailscale?: () => Promise<any>, fetch?: typeof fetch, base?: string }} AddDeps
 */

/**
 * `vyre phone add`: the steps, then the checks until they pass or the code runs out. The relay is
 * the default (nothing to install on the phone first); Tailscale is the optional last step that
 * makes it direct and private, or the whole path with --tailscale-only.
 * @param {{ iphone?: boolean, android?: boolean, tailscaleOnly?: boolean }} flags
 * @param {AddDeps} [deps]
 */
export async function add(flags, deps = {}) {
  const t = await target();
  if (!t) return EXIT.FAILED;
  if (!t.address) return fail("the box has no address yet, so a phone cannot reach it", { next: "vyre name, then vyre phone add" });
  const address = t.address.replace(/\/$/, "");
  const io = deps.io || realIO;

  // The pairing first: it is the one step that asks the person, and nothing is worth showing
  // without it. The relay's single-use QR (https://vyre.run/pair#<offer>); on a Mac it is minted
  // on the box through the link. A box without the relay falls back to Tailscale and says so.
  let code = null, expires = Date.now() + (deps.life ?? CODE_LIFE);
  /** @type {string|null} */ let offer = null;
  let noRelay = false;
  // From a Mac the box cannot check a proof made here (link.call refuses human-only tools, and a
  // Touch ID on the Mac is not something the box can verify), so pairing happens on the box.
  // TODO(e2e, ADR 0032): the Mac's Secure Enclave device key (approved, after batch 2) will let
  // the Mac prove human-only calls to the box; then call relay.pair.start through the link here.
  if (!t.local && !flags.tailscaleOnly) {
    return fail("pairing a phone needs you at the box, and this Mac cannot prove that to it",
      { next: "open your box's Deck (Settings, Devices, Add a device), or run vyre phone add on the box itself" });
  }
  if (!flags.tailscaleOnly) {
    const r = await callAsPerson("relay.pair.start", {}, { io });
    if (r.error && r.error.code === "no_such_tool") noRelay = true;
    else if (r.error) return failTool(r.error, "vyre phone add --tailscale-only pairs over Tailscale instead");
    else {
      offer = r.data && r.data.url;
      if (r.data && r.data.expiresAt && deps.life === undefined) expires = Number(r.data.expiresAt);
    }
  }
  if (!offer && t.local) {
    const r = await callAsPerson("presence.code", {}, { io });
    if (r.error) return failTool(r.error);
    code = typeof r.data === "string" ? r.data : r.data && r.data.code;
    if (r.data && r.data.expires && deps.life === undefined) expires = Number(r.data.expires);
  }

  const ts = await (deps.tailscale || (() => tailnet.status()))().catch(() => null);
  // The native Android app, when the box serves one: one manifest fetch, no retries.
  const served = flags.iphone ? null : appManifest((deps.base || address).replace(/\/$/, ""), deps.fetch || globalThis.fetch);
  const [d0, k0, r0, am] = await Promise.all([t.tool("push.devices"), t.tool("presence.keys"), t.tool("relay.devices.list"), served]);
  const app = am && am.manifest ? { version: am.manifest.version, url: `${address}/apps/android/${apkName(am.manifest)}` } : null;
  if (d0.error) return failTool(d0.error);
  if (k0.error) return failTool(k0.error);
  const before = { devices: list(d0), keys: list(k0), relay: relayDevices(r0) };

  const phone = flags.iphone ? "iPhone" : flags.android ? "Android" : null;
  const tailscale = { tailnet: tailnetOf(address), login: ts && ts.login ? ts.login : null, address: address + "/" };
  const install = {
    iphone: "Safari: Share, then Add to Home Screen. Open Vyre from the Home Screen: notifications work only there.",
    android: "Chrome: the menu, then Install app. Or the native app over a cable: vyre phone add --android --usb",
  };
  const installFor = flags.iphone ? { iphone: install.iphone } : flags.android ? { android: install.android } : install;
  if (json()) {
    return emit({ box: address, phone, network: offer ? "relay" : "tailscale", url: offer || address + "/", code, expires,
      install: installFor, ...(app ? { app } : {}), tailscale, ...(noRelay ? { relay: "this box has no relay yet" } : {}),
      checks: evaluate(before, before, { address }) });
  }

  const pad = s => bold(s.padEnd(14));
  const indent = "                   ";
  out(`  Pairing a phone with the box ${dim("(" + hostOf(address) + ")")}`);
  out(dim(offer ? "  Confirmed · the QR works once, for 10 minutes" : code ? "  Confirmed · the code works once, for 10 minutes" : ""));
  if (noRelay && !flags.tailscaleOnly) out(dim("  This box has no relay yet, so the phone pairs over Tailscale"));
  out("");
  out(`  1 ${pad("Which phone?")}${phone || "iPhone or Android"}${phone ? "" : dim("  (--iphone or --android shows one)")}`);
  let n = 2;
  if (offer) {
    out(`  ${n++} ${pad("Pair")}${dim("scan with the phone's camera; nothing to install first")}`);
    if (colour) for (const l of terminal(qr(offer), { indent: "     " })) out(l);
    out(dim(`${indent}${offer}`));
  } else {
    out(`  ${n++} ${pad("Network")}Tailscale${tailscale.tailnet ? ", tailnet " + tailscale.tailnet : ""}`);
    out(dim(`${indent}Get Tailscale on the phone, and sign in as ${tailscale.login || "the same account as the box"}`));
    out(`  ${n++} ${pad("Open Vyre")}${address}`);
    if (colour) for (const l of terminal(qr(address + "/"), { indent: "     " })) out(l);
    else out(dim(`${indent}Type this address on the phone (the QR code shows in a colour terminal)`));
    out(code ? `${indent}${dim("When it asks for a code (Passkey, Add), type")} ${signal(spaced(code))}`
      : dim(`${indent}The passkey code comes from the box: vyre presence code there, then type it on the phone`));
  }
  const steps = Object.entries(installFor).map(([k, v]) => [k === "iphone" ? "iPhone" : "Android", v]);
  out(`  ${n++} ${pad("Install")}${steps[0][0]}: ${steps[0][1]}`);
  for (const [name, how] of steps.slice(1)) out(`${indent}${name}: ${how}`);
  if (app) {
    out(`${indent}${dim("or the app:")} ${app.url}`);
    if (colour) for (const l of terminal(qr(app.url), { indent: "     " })) out(l);
  }
  out(dim(`${indent}Then on Now: turn on notifications, and add a passkey`));
  out(`  ${n++} ${bold("Checks")}`);
  if (offer) {
    // The optional step after the checks: the relay works everywhere; Tailscale makes it direct.
    const tail = [`  ${n} ${pad("Faster and private: add Tailscale")}${dim("(optional)")}`,
      dim(`${indent}Get Tailscale on the phone and sign in as ${tailscale.login || "the same account as the box"}; Vyre switches`),
      dim(`${indent}to ${address} by itself when the phone answers there`)];
    const code0 = await watch(t, { address, before, expires }, deps);
    out("");
    for (const l of tail) out(l);
    if (code0 !== 0) return code0;
    return switched(t, deps);
  }
  return watch(t, { address, before, expires }, deps);
}

/**
 * After a relay pairing: wait for the phone to switch to Tailscale (the relay's device.moved
 * event), for as long as the person keeps the terminal here. Enter or Ctrl-C ends it; so does a
 * pipe, which does not wait at all.
 * @param {{ local: boolean }} t @param {AddDeps} deps @returns {Promise<number>}
 */
function switched(t, deps) {
  const input = deps.input !== undefined ? deps.input : process.stdin.isTTY ? process.stdin : null;
  if (!input) return Promise.resolve(0);
  out(dim("                   Waiting here for the switch · Enter or Ctrl-C finishes"));
  return new Promise(resolve => {
    let done = false;
    const end = (/** @type {string} */ line) => {
      if (done) return;
      done = true;
      stop(); clearTimeout(timer);
      input.off("data", onKey); input.pause?.();
      process.off("SIGINT", onInt);
      if (line) out(line);
      resolve(0);
    };
    const stop = follow(t.local, ["device.moved"], (_, d) => {
      if (d.path === "direct") {
        const rtt = d.rtt;
        end(`  ${signal("●")} Switched to Tailscale, direct${rtt != null && Number.isFinite(Number(rtt)) ? ` ${Math.round(Number(rtt))} ms` : ""}`);
      }
    });
    const onKey = chunk => { if (/[\r\n]/.test(String(chunk))) end(""); };
    const onInt = () => end("");
    const timer = setTimeout(() => end(dim("  still on the relay · it switches by itself once Tailscale is on the phone")), deps.life ?? CODE_LIFE);
    input.on("data", onKey); input.resume?.();
    process.on("SIGINT", onInt);
  });
}

/**
 * Read push.devices and presence.keys again whenever something may have changed, and test the
 * first new device with a receipt. The phone showing it (push.delivered) and an installed app
 * (push.seen) arrive on the stream. Resolves to 0 when the checks pass, 1 when the code runs out.
 */
function watch(t, { address, before, expires }, deps) {
  const tty = deps.tty ?? Boolean(process.stdout.isTTY);
  const input = deps.input !== undefined ? deps.input : process.stdin.isTTY ? process.stdin : null;
  /** @type {Tested | null} */
  let tested = null;
  /** Receipts the phones posted back, and whether any screen ran installed, since the start. */
  const receipts = new Set();
  let standalone = false;
  let now = before;
  const seen = () => ({ address, tested, delivered: Boolean(tested && tested.receipt && receipts.has(tested.receipt)), standalone });
  let checks = evaluate(before, before, seen());
  let drawn = 0;

  const left = () => { const s = Math.max(0, Math.round((expires - Date.now()) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const status = () => dim(`    the code works for ${left()} more${input ? " · press Enter to check again" : ""} · Ctrl-C stops`);
  const draw = () => {
    // A terminal gets the block redrawn in place; a pipe gets each change once.
    if (tty) {
      if (drawn) process.stdout.write(`\x1b[${drawn}A\x1b[J`);
      const lines = [...checks.map(checkLine), status()];
      process.stdout.write(lines.join("\n") + "\n");
      drawn = lines.length;
    }
  };
  const shown = new Map();
  const report = () => {
    if (tty) return draw();
    for (const c of checks) { const k = c.state + (c.note || ""); if (shown.get(c.id) !== k) { shown.set(c.id, k); out(checkLine(c)); } }
  };
  report();

  return new Promise(resolve => {
    let busy = false, again = false, done = false;
    const check = async () => {
      if (done) return;
      if (busy) { again = true; return; }
      busy = true;
      try {
        const [d, k, rl] = await Promise.all([t.tool("push.devices"), t.tool("presence.keys"), t.tool("relay.devices.list")]);
        now = { devices: d.error ? before.devices : list(d), keys: k.error ? before.keys : list(k), relay: rl.error ? before.relay : relayDevices(rl) };
        const fresh = now.devices.filter(x => !before.devices.some(b => b.device === x.device));
        if (fresh.length && !tested) {
          const r = await t.tool("push.test", { device: fresh[0].device, receipt: true });
          tested = { device: fresh[0].device, sent: r.data ? Number(r.data.sent) || 0 : 0, failed: r.data ? Number(r.data.failed) || 0 : 1,
            receipt: r.data && typeof r.data.receipt === "string" ? r.data.receipt : null };
        }
        settle();
      } finally {
        busy = false;
        if (again && !done) { again = false; check(); }
      }
    };
    /** Evaluate what is known now, show it, and end when everything the box can prove is done. */
    const settle = () => {
      if (done) return;
      checks = evaluate(before, now, seen());
      report();
      if (finished(checks)) {
        const fresh = now.devices.filter(x => !before.devices.some(b => b.device === x.device));
        const name = (fresh[0] && fresh[0].label) || (now.keys.find(x => !before.keys.some(b => b.id === x.id)) || {}).name || "The phone";
        end(0, `  ${signal("●")} ${name} is ready · ${checks.filter(c => c.state === "ok").length} of 5 checks passed`);
      }
    };
    const onEvent = (/** @type {string} */ type, /** @type {any} */ p) => {
      if (type === "push.delivered") { if (p.receipt) receipts.add(String(p.receipt)); settle(); }
      else if (type === "push.seen") { if (p.standalone === true && !standalone) { standalone = true; settle(); } }
      else check();
    };
    const onKey = chunk => { if (/[\r\n]/.test(String(chunk))) check(); };
    const onInt = () => end(0, dim("  stopped watching · vyre phone list shows what arrived"));
    const stopStream = follow(t.local, ["presence.enrolled", "push.subscribed", "push.delivered", "push.seen"], onEvent);
    const every = setInterval(check, deps.every ?? RECHECK);
    const tick = tty ? setInterval(draw, 1000) : null;
    const expiry = setTimeout(() => {
      const waiting = checks.filter(c => c.state === "wait" && c.id !== "app").map(c => c.label.toLowerCase());
      end(EXIT.FAILED, beacon(`  the code ran out${waiting.length ? " before: " + waiting.join(", ") : ""}`), "vyre phone add again for a new code; vyre phone list shows what arrived");
    }, Math.max(0, expires - Date.now()));
    if (input) { input.on("data", onKey); input.resume?.(); }
    process.on("SIGINT", onInt);

    function end(code, line, next) {
      if (done) return;
      done = true;
      clearInterval(every); if (tick) clearInterval(tick); clearTimeout(expiry);
      stopStream();
      process.off("SIGINT", onInt);
      if (input) { input.off("data", onKey); input.pause?.(); }
      if (tty) draw();
      out(line);
      if (next) out(dim("  next: " + next));
      resolve(code);
    }
  });
}

// ------------------------------------------------------------ Android over adb

/**
 * Run adb: VYRE_ADB_BIN, else adb on PATH, else the Android SDK's. { code: 127 } when none is there.
 * @param {string[]} args @param {NodeJS.ProcessEnv} [env] @param {number} [timeout]
 */
function adb(args, env = process.env, timeout = 10_000) {
  const bins = env.VYRE_ADB_BIN ? [env.VYRE_ADB_BIN] : ["adb", path.join(os.homedir(), "Library", "Android", "sdk", "platform-tools", "adb")];
  const one = bin => new Promise(resolve => execFile(bin, args, { timeout }, (e, stdout, stderr) => {
    const code = !e ? 0 : /** @type {any} */ (e).code === "ENOENT" || /** @type {any} */ (e).code === "EACCES" ? 127 : Number(/** @type {any} */ (e).code) || 1;
    resolve({ code, out: String(stdout), err: String(stderr) });
  }));
  return (async () => {
    for (const bin of bins) {
      if (bin !== "adb" && !fs.existsSync(bin)) continue;
      const r = /** @type {{ code: number, out: string, err: string }} */ (await one(bin));
      if (r.code !== 127) return r;
    }
    return { code: 127, out: "", err: "" };
  })();
}

/**
 * Phones `adb devices -l` lists. Pure, for tests. A serial with a port or an mDNS name is wireless.
 * @param {string} text
 */
export function adbDevices(text) {
  return String(text).split("\n").slice(1).map(l => l.trim()).filter(Boolean).map(l => {
    const [serial, state, ...rest] = l.split(/\s+/);
    const kv = Object.fromEntries(rest.map(p => p.split(":")).filter(p => p.length === 2));
    return { serial, state, model: kv.model ? kv.model.replace(/_/g, " ") : null, wireless: /:\d+$|_adb-tls-connect/.test(serial) };
  });
}

/**
 * @typedef {{ version: string, versionCode?: number, sha: string, sha256: string, size: number,
 *   minSdk?: number, built?: string, file?: string }} AppManifest
 */

/** The APK's file name: the manifest's, else vyre-<version>-<sha7>.apk. */
export const apkName = (/** @type {AppManifest} */ m) => m.file || `vyre-${m.version}-${String(m.sha).slice(0, 7)}.apk`;

/**
 * The Android app the box serves: GET <box>/apps/android.json. One fetch, no retries.
 * { manifest } when it serves one; { missing } for a 404, a box without the route, or a manifest
 * that is not whole; { error } when the box did not answer at all.
 * @param {string} base @param {typeof fetch} [f]
 * @returns {Promise<{ manifest?: AppManifest, missing?: boolean, error?: string }>}
 */
export async function appManifest(base, f = globalThis.fetch) {
  let r;
  try { r = await f(`${base}/apps/android.json`, { cache: "no-store", signal: AbortSignal.timeout(8000) }); }
  catch (e) { return { error: String(e && e.message || e) }; }
  if (!r.ok) return { missing: true };
  /** @type {any} */ let m;
  try { m = await r.json(); } catch { return { missing: true }; }
  const whole = m && typeof m.version === "string" && /^[0-9a-f]{64}$/i.test(String(m.sha256)) && Number(m.size) > 0
    && (m.file ? /^[\w.-]+\.apk$/.test(String(m.file)) : typeof m.sha === "string" && m.sha.length >= 7);
  return whole ? { manifest: m } : { missing: true };
}

/**
 * Download the APK into a fresh temp folder, counting its size and sha256 on the way.
 * { file, dir } when both match the manifest; { mismatch: "size"|"sha256" } (the file already
 * deleted) when not; { missing } when the box does not serve it.
 * @param {string} url @param {AppManifest} m @param {typeof fetch} f
 * @returns {Promise<{ file?: string, dir?: string, mismatch?: "size"|"sha256", missing?: boolean, error?: string }>}
 */
async function download(url, m, f) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-apk-"));
  const file = path.join(dir, apkName(m));
  const drop = () => fs.rmSync(dir, { recursive: true, force: true });
  const want = Number(m.size);
  let size = 0;
  const hash = crypto.createHash("sha256");
  try {
    const r = await f(url, { cache: "no-store", signal: AbortSignal.timeout(5 * 60_000) });
    if (!r.ok || !r.body) { drop(); return { missing: true }; }
    // Stop reading past the promised size: a bigger file is already the wrong one.
    const count = new Transform({ transform(chunk, _, cb) {
      size += chunk.length;
      if (size > want) return cb(Object.assign(new Error("larger than the manifest says"), { code: "too_big" }));
      hash.update(chunk); cb(null, chunk);
    } });
    await pipeline(Readable.fromWeb(/** @type {any} */ (r.body)), count, fs.createWriteStream(file));
  } catch (e) {
    drop();
    return /** @type {any} */ (e).code === "too_big" ? { mismatch: "size" } : { error: String(e && /** @type {any} */ (e).message || e) };
  }
  if (size !== want) { drop(); return { mismatch: "size" }; }
  if (hash.digest("hex") !== String(m.sha256).toLowerCase()) { drop(); return { mismatch: "sha256" }; }
  return { file, dir };
}

/**
 * @typedef {{ io?: import("../presence.js").PresenceIO, fetch?: typeof fetch, base?: string, life?: number,
 *   target?: () => Promise<Awaited<ReturnType<typeof target>>>, pair?: () => Promise<any> }} AndroidDeps
 */

/**
 * `vyre phone add --android --usb|--wireless`: the native app from the box, installed over adb,
 * then opened on a relay pairing offer. deps are for tests: fetch, the box's base URL, the target
 * and the pairing call.
 * @param {{ wireless?: boolean }} flags @param {AndroidDeps} [deps]
 */
export async function android(flags, deps = {}) {
  const how = flags.wireless ? "wireless" : "usb";
  const f = deps.fetch || globalThis.fetch;
  const v = await adb(["version"]);
  if (v.code === 127) return fail("adb is not installed, so Vyre cannot install the app over a cable",
    { code: "no_adb", next: "install Android platform-tools (brew install android-platform-tools), or put the Android SDK's platform-tools on PATH" });
  const devs = adbDevices((await adb(["devices", "-l"])).out);
  const found = devs.filter(d => d.state === "device" && d.wireless === (how === "wireless"));
  if (!found.length) {
    if (devs.some(d => d.state === "unauthorized")) return fail("a phone is connected but has not allowed this computer", { code: "unauthorized", next: "tap Allow on the phone, then vyre phone add --android --" + how });
    return how === "usb"
      ? fail("no phone over USB", { code: "no_phone", next: "plug it in and turn on USB debugging in Developer options, then vyre phone add --android --usb" })
      : fail("no phone over Wireless debugging", { code: "no_phone", next: "Developer options, Wireless debugging, Pair device with pairing code, then adb pair <ip:port>" });
  }
  const phone = found[0];
  const model = phone.model || phone.serial;
  const via = how === "usb" ? "USB" : "Wireless debugging";
  if (!json()) out(`  Found ${bold(model)} over ${via}`);

  const t = await (deps.target || target)();
  if (!t) return EXIT.FAILED;
  if (!t.address && !deps.base) return fail("the box has no address yet, so this computer cannot fetch the app from it", { next: "vyre name, then vyre phone add --android --" + how });
  const base = (deps.base || /** @type {string} */ (t.address)).replace(/\/$/, "");
  const noApk = () => fail("the box has no Android app to serve yet, so there is nothing to install", { code: "no_apk", next: "vyre phone add for the web app; the native app comes with a box that serves its APK" });
  const got = await appManifest(base, f);
  if (got.error) return fail(`could not reach the box at ${hostOf(base)} for the app: ${got.error}`, { code: "unreachable", next: "check this computer is on the tailnet (tailscale status), then again" });
  if (!got.manifest) return noApk();
  const m = got.manifest;

  const sdk = Number((await adb(["-s", phone.serial, "shell", "getprop", "ro.build.version.sdk"])).out.trim());
  if (m.minSdk && Number.isFinite(sdk) && sdk > 0 && sdk < Number(m.minSdk)) {
    return fail(`${model} runs Android API level ${sdk}, and Vyre ${m.version} needs ${m.minSdk} or newer`, { code: "too_old", next: "vyre phone add for the web app, which works in Chrome" });
  }

  const dl = await download(`${base}/apps/android/${apkName(m)}`, m, f);
  if (dl.missing) return noApk();
  if (dl.error) return fail(`the download from ${hostOf(base)} stopped: ${dl.error}`, { code: "download_failed", next: "vyre phone add --android --" + how + " again" });
  if (dl.mismatch) return fail(`the APK's ${dl.mismatch} is not what the box says: the download was not what the box says it built; nothing was installed`, { code: "mismatch", next: "vyre phone add --android --" + how + " again; if it repeats, the box's app build needs a look" });

  const result = { phone: { serial: phone.serial, model: phone.model, via: how }, version: m.version, sha: m.sha || null, installed: false, opened: false, paired: /** @type {boolean|null} */ (null) };
  try {
    if (!json()) out(`  Installing Vyre ${m.version} ${dim("(adb, no store needed)")}`);
    const ins = await adb(["-s", phone.serial, "install", "-r", /** @type {string} */ (dl.file)], process.env, 5 * 60_000);
    if (ins.code !== 0 || /Failure/.test(ins.out)) {
      const why = ((ins.out + "\n" + ins.err).split("\n").map(l => l.trim()).filter(l => /Failure|error/i.test(l)).pop() || `adb exited ${ins.code}`);
      return fail(`adb could not install Vyre: ${why}`, { code: "install_failed",
        next: /UPDATE_INCOMPATIBLE|SIGNATURES/.test(why) ? "remove the Vyre app on the phone (another build signed it), then again" : "vyre phone add --android --" + how + " again" });
    }
    result.installed = true;
  } finally {
    if (dl.dir) fs.rmSync(dl.dir, { recursive: true, force: true });
  }

  // The pairing: the relay's offer, handed to the app as a vyre://pair link. Minting it needs
  // the person at the box; a Mac cannot prove that yet (see add), and a box without the relay
  // has no offer. Then the phone pairs by the QR, as the web app does.
  const scan = "Open Vyre on the phone and scan the pairing QR: vyre phone add on the box";
  /** @type {string|null} */ let offer = null, expiresAt = null;
  if (t.local) {
    const r = await (deps.pair || (() => callAsPerson("relay.pair.start", {}, { io: deps.io || realIO })))();
    if (r && r.data && r.data.url) { offer = String(r.data.url); expiresAt = r.data.expiresAt ? Number(r.data.expiresAt) : null; }
  }
  if (!offer) {
    if (json()) return emit({ ...result, pair: scan });
    out(dim("  " + scan));
    return 0;
  }
  // Listen before opening the app, so a quick pairing is not missed.
  let onPaired = (/** @type {any} */ _) => {};
  const stop = json() ? () => {} : follow(true, ["device.paired"], (_, p) => onPaired(p));
  // adb shell hands the line to the phone's shell: quote the link, which has no quote in it.
  const link = `vyre://pair?offer=${encodeURIComponent(offer).replace(/'/g, "%27")}`;
  const am = await adb(["-s", phone.serial, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `'${link}'`, "sh.vyre.app"]);
  result.opened = am.code === 0 && !/Error|Exception/.test(am.out + am.err);
  if (json()) { stop(); return emit({ ...result, ...(result.opened ? {} : { pair: scan }) }); }
  if (!result.opened) { stop(); out(dim("  " + scan)); return 0; }
  out("  Opened Vyre on the phone");
  const life = deps.life ?? (expiresAt ? Math.max(0, expiresAt - Date.now()) : CODE_LIFE);
  return new Promise(resolve => {
    let done = false;
    const end = (/** @type {number} */ code, /** @type {string} */ line) => { if (done) return; done = true; stop(); clearTimeout(timer); process.off("SIGINT", onInt); out(line); resolve(code); };
    onPaired = p => end(0, `  ${signal("●")} Paired${p && p.name ? dim(" · " + p.name) : ""}`);
    const onInt = () => end(0, dim("  stopped watching · vyre phone list shows whether it paired"));
    const timer = setTimeout(() => end(EXIT.FAILED, beacon("  the pairing offer ran out before the phone used it") + "\n" + dim("  next: vyre phone add on the box for a new QR")), life);
    process.on("SIGINT", onInt);
  });
}

// ------------------------------------------------------------ list, remove, test

export async function listPhones() {
  const t = await target();
  if (!t) return EXIT.FAILED;
  const [d, k, rl] = await Promise.all([t.tool("push.devices"), t.tool("presence.keys"), t.tool("relay.devices.list")]);
  if (d.error) return failTool(d.error);
  if (k.error) return failTool(k.error);
  const devices = list(d), passkeys = list(k).filter(x => x.kind === "passkey"), relayed = relayDevices(rl);
  if (json()) return emit({ devices, passkeys, relay: relayed });
  if (!devices.length && !passkeys.length && !relayed.length) { out(dim("  no phones yet · vyre phone add")); return 0; }
  const when = ms => (ms ? new Date(ms).toISOString().slice(0, 10) : "");
  if (devices.length) out(bold("  Notifications"));
  for (const x of devices) {
    out(`    ${bold(String(x.device))} ${x.label || dim("no name")} ${dim([x.service, "added " + when(x.at), x.last_ok ? "last sent " + when(x.last_ok) : "", x.fails ? `${x.fails} failed` : ""].filter(Boolean).join(" · "))}`);
  }
  if (relayed.length) out(bold("  Through the relay"));
  for (const x of relayed) {
    out(`    ${bold(String(x.id))} ${x.name || dim("no name")} ${dim([x.kind, x.online ? (x.path === "relay" ? "online through the relay" : "online") : "offline", x.trusted === false ? "not trusted" : "", "paired " + when(x.pairedAt), x.lastSeen ? "last seen " + when(x.lastSeen) : ""].filter(Boolean).join(" · "))}`);
  }
  if (passkeys.length) out(bold("  Passkeys"));
  for (const x of passkeys) out(`    ${bold(String(x.id))} ${x.name || dim("no name")} ${dim(["added " + when(x.created), x.last_used ? "last used " + when(x.last_used) : ""].filter(Boolean).join(" · "))}`);
  out(dim("  vyre phone remove <id> forgets one"));
  return 0;
}

/** @param {string[]} ids @param {{ io?: import("../presence.js").PresenceIO }} [deps] */
export async function remove(ids, deps = {}) {
  if (!ids.length) return usage("vyre phone remove needs an id", "vyre phone list shows them");
  const t = await target();
  if (!t) return EXIT.FAILED;
  const [d, k, rl] = await Promise.all([t.tool("push.devices"), t.tool("presence.keys"), t.tool("relay.devices.list")]);
  if (d.error) return failTool(d.error);
  if (k.error) return failTool(k.error);
  const removed = [];
  for (const id of ids) {
    if (relayDevices(rl).some(x => x.id === id)) {
      // Removing one asks for the person (it removes the device's presence key too).
      const r = t.local ? await callAsPerson("relay.devices.remove", { id }, { io: deps.io || realIO })
        : await callAsPerson("link.call", { tool: "relay.devices.remove", input: { id } }, { io: deps.io || realIO });
      if (r.error) return failTool(r.error);
      removed.push({ id, kind: "relay" });
    } else if (list(d).some(x => x.device === id)) {
      const r = await t.tool("push.unsubscribe", { device: id });
      if (r.error) return failTool(r.error);
      removed.push({ id, kind: "device" });
    } else if (list(k).some(x => x.id === id)) {
      // Removing a passkey needs presence on the box; a Mac cannot give it over the link.
      if (!t.local) return fail(`${id} is a passkey, and removing one needs you at the box`, { next: `vyre phone remove ${id} on the box, or remove it in the Deck` });
      const r = await callAsPerson("presence.remove", { id }, { io: deps.io || realIO });
      if (r.error) return failTool(r.error);
      removed.push({ id, kind: "passkey" });
    } else return fail(`no notification device or passkey ${id}`, { next: "vyre phone list shows them" });
  }
  if (json()) return emit({ removed });
  for (const r of removed) out(`  removed ${r.kind === "device" ? "notification device" : r.kind === "relay" ? "relay device" : "passkey"} ${bold(r.id)}`);
  return 0;
}

/** @param {string} [id] */
export async function testPush(id) {
  const t = await target();
  if (!t) return EXIT.FAILED;
  const d = await t.tool("push.devices");
  if (d.error) return failTool(d.error);
  if (!list(d).length) return fail("no device gets notifications yet", { next: "vyre phone add" });
  if (id && !list(d).some(x => x.device === id)) return fail(`no notification device ${id}`, { next: "vyre phone list shows them" });
  const r = await t.tool("push.test", id ? { device: id } : {});
  if (r.error) return failTool(r.error);
  if (json()) return emit(r.data);
  const { sent = 0, failed = 0, dropped = 0 } = r.data || {};
  out(`  ${sent ? signal("●") : beacon("○")} sent to ${sent} device${sent === 1 ? "" : "s"}${failed ? beacon(` · ${failed} failed`) : ""}${dropped ? dim(` · ${dropped} gone and forgotten`) : ""}`);
  if (sent) out(dim("  The push service took it; check the phone shows \"Vyre can reach this device\"."));
  return sent || !failed ? 0 : EXIT.FAILED;
}

// ------------------------------------------------------------ the command

const HELP = `
  vyre phone add               the steps to put a phone on the box, then live checks
      --iphone | --android     only that phone's install step
      --tailscale-only         skip the relay: Tailscale on the phone first, then the box's address
      --android --usb          the native app over a cable: downloads the APK the box serves,
                               checks its size and sha256, installs it with adb, opens it to pair
      --android --wireless     the same over Wireless debugging
  vyre phone list              the devices that get notifications, and the passkeys
  vyre phone remove <id>...    forget a notification device, or remove a passkey (asks you first)
  vyre phone test [id]         send a test notification to every device, or one

  add pairs through the relay by default: it asks you first, then shows a QR that works once
  for 10 minutes, so the phone needs nothing installed first. Adding Tailscale afterwards makes the
  path direct and private. With --tailscale-only (or on a box without the relay) it mints a
  one-time code for the phone's passkey instead. Then it watches until the phone shows up: a new
  notification device, a test notification the phone showed, and a new passkey. It checks again every minute and when you press Enter.
  With --json it prints the address, the code and the steps as one JSON value and does not watch.`;

export default {
  name: "phone", order: 46, usage: USAGE, summary: "add a phone to your box, list, remove and test the ones it has", help: HELP,
  async run(args) {
    const { flags, pos } = parse(args, { bool: ["iphone", "android", "usb", "wireless", "relay", "tailscale-only"], values: [], cmd: "phone" });
    const [sub0 = "list", ...rest] = pos;
    const sub = ({ ls: "list", rm: "remove", pair: "add" })[sub0] || sub0;
    if (sub === "add") {
      if (rest.length) return usage(`vyre phone add takes no words: ${rest.join(" ")}`);
      if ((flags.usb || flags.wireless) && !flags.android) return usage("vyre phone add: --usb and --wireless are for --android", "vyre phone add --android --usb");
      if (flags.usb && flags.wireless) return usage("vyre phone add: --usb or --wireless, not both");
      if (flags.iphone && flags.android) return usage("vyre phone add: --iphone or --android, not both");
      if (flags.relay && flags["tailscale-only"]) return usage("vyre phone add: the relay is the default; --tailscale-only skips it");
      if (flags.usb || flags.wireless) return android(flags);
      // --relay is the default now, kept so old notes still work.
      return add({ iphone: flags.iphone, android: flags.android, tailscaleOnly: Boolean(flags["tailscale-only"]) });
    }
    if (sub === "list") return listPhones();
    if (sub === "remove") return remove(rest);
    if (sub === "test") return testPush(rest[0]);
    return usage(`vyre phone ${sub}: not a subcommand`, "vyre phone add, list, remove <id> or test [id]");
  },
};
