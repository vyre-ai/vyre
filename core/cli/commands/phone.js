// @ts-check
// `vyre phone`: put a phone on the box, and look after the phones it has.
//
//   vyre phone add [--iphone|--android]    the steps the Deck's "Add your phone" sheet shows: the
//                                          box's address (and a QR of it), the network, a one-time
//                                          code for the passkey, how to install, then live checks
//   vyre phone add --relay                 pair through the relay instead (no Tailscale on the
//                                          phone): a single-use QR from relay.pair.start
//   vyre phone add --android --usb         the native app over a cable (adb); --wireless for
//                                          Wireless debugging. Needs an APK the box serves
//   vyre phone list                        the devices that get notifications, and the passkeys
//   vyre phone remove <id>...              forget a notification device or remove a passkey
//   vyre phone test [id]                   send a test notification
//
// The phone pairs with the box, so on a box every call is local; on a Mac linked to a box the
// reads go over link.call. Minting the code and removing a passkey need presence on the box
// itself, which a Mac cannot give over the link (a passkey is the only proof the box takes from
// another machine, ADR 0004), so from a Mac those two point at the box or the Deck instead.
//
// The checks watch what the box can see: a new push device (push.devices, which emits nothing,
// so it is read again every 60 s and whenever Enter is pressed), a new passkey (presence.enrolled
// on the event stream, which also triggers a read), and a test notification the push service
// took (push.test). HTTPS is inferred: a browser offers push and passkeys only on a secure page.
// Opened as an app is known only for an iPhone (Apple sends web push to Home Screen apps alone).
// Whether the phone's path is direct or relayed: the relay says so for its own devices
// (relay.devices.list path "relay"); for a phone on the tailnet the box cannot say yet.
// The relay tools (ADR 0026) are found by trying them: a box without the relay module answers
// no_such_tool, and everything here works without them.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { call, request } from "../../daemon/client.js";
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
 * The five checks from what the box has seen since the start. Pure, for tests.
 * @param {Seen} before @param {Seen} now
 * @param {{ address?: string|null, tested?: { device: string, sent: number, failed: number } | null }} [o]
 * @returns {Check[]}
 */
export function evaluate(before, now, { address = null, tested = null } = {}) {
  const had = new Set([...before.devices.map(d => d.device), ...before.keys.map(k => k.id), ...(before.relay || []).map(r => "relay:" + r.id)]);
  const devices = now.devices.filter(d => !had.has(d.device));
  const relayed = (now.relay || []).filter(r => !had.has("relay:" + r.id));
  const keys = now.keys.filter(k => k.kind === "passkey" && !had.has(k.id));
  const any = devices.length > 0 || keys.length > 0 || relayed.length > 0;
  const https = String(address || "").startsWith("https:");
  const apple = devices.some(d => APPLE.test(String(d.service)));
  return [
    { id: "reached", label: "Phone reached the box", state: any ? "ok" : "wait",
      note: relayed.some(r => r.path === "relay") ? "through the relay" : any ? "direct or relayed: the box cannot tell for a tailnet phone yet" : undefined },
    { id: "https", label: "Secure address works (HTTPS)", state: any && https ? "ok" : !https && address ? "failed" : "wait",
      note: any && https ? "a browser offers notifications and passkeys only on a secure page" : !https && address ? `${address} is not https` : undefined },
    { id: "app", label: "Opened as an app, not a browser tab", state: apple ? "ok" : devices.length ? "unknown" : "wait",
      note: apple ? "an iPhone sends notifications only from the Home Screen app" : devices.length ? "the box cannot tell an Android app from a tab yet" : undefined },
    { id: "push", label: "Test notification sent", state: !tested ? "wait" : tested.sent > 0 ? "ok" : "failed",
      note: tested ? (tested.sent > 0 ? "the push service took it; check the phone shows it" : `the push service refused it · vyre phone test ${tested.device}`) : undefined },
    { id: "passkey", label: "Face ID key saved for approvals", state: keys.length ? "ok" : "wait", note: keys.length ? String(keys[0].name || keys[0].id) : undefined },
  ];
}

/** Everything the box can prove is done: all but "opened as an app" on Android. */
const finished = checks => checks.every(c => c.state === "ok" || (c.id === "app" && c.state === "unknown"));

const mark = c => c.state === "ok" ? signal("✓") : c.state === "failed" ? beacon("✗") : c.state === "unknown" ? dim("?") : dim("·");
const checkLine = c => `    ${mark(c)} ${c.state === "ok" ? c.label : c.state === "failed" ? beacon(c.label) : dim(c.label)}${c.note ? dim(" · " + c.note) : ""}`;

// ------------------------------------------------------------ the event stream

/**
 * Follow the box's presence.enrolled events: this vyred's stream on a box, the link's copy of the
 * box's stream on a Mac. Returns a stop function. Losing the stream only leaves the 60 s re-read.
 */
function follow(local, onEvent) {
  const at = local ? "/v1/events/stream" : "/v1/link/events";
  let buf = "";
  const req = http.request({ socketPath: config.paths().socket, path: `${at}?type=presence.enrolled&since=latest`, method: "GET",
    headers: { accept: "text/event-stream", "x-vyre-caller": "cli" } }, res => {
    if (res.statusCode !== 200) { res.resume(); return; }
    res.setEncoding("utf8");
    res.on("data", chunk => {
      const r = parseSSE(buf + chunk);
      buf = r.rest;
      for (const f of r.frames) if (f.event === "presence.enrolled") onEvent(f);
    });
  });
  req.on("error", () => {});
  req.end();
  return () => req.destroy();
}

// ------------------------------------------------------------ add

/**
 * @typedef {{ io?: import("../presence.js").PresenceIO, input?: NodeJS.ReadableStream | null, tty?: boolean,
 *   every?: number, life?: number, tailscale?: () => Promise<any> }} AddDeps
 */

/**
 * `vyre phone add`: the steps, then the checks until they pass or the code runs out.
 * @param {{ iphone?: boolean, android?: boolean, relay?: boolean }} flags
 * @param {AddDeps} [deps]
 */
export async function add(flags, deps = {}) {
  const t = await target();
  if (!t) return EXIT.FAILED;
  if (!t.address) return fail("the box has no address yet, so a phone cannot reach it", { next: "vyre name, then vyre phone add" });
  const address = t.address.replace(/\/$/, "");

  // The code first: it is the one step that asks the person, and nothing is worth showing without it.
  let code = null, expires = Date.now() + (deps.life ?? CODE_LIFE);
  /** @type {string|null} */ let offer = null;
  if (flags.relay) {
    // A single-use relay QR (https://vyre.run/pair#<offer>), 10 minutes. On a Mac it is minted on
    // the box through the link, with this Mac's proof of presence.
    const r = t.local ? await callAsPerson("relay.pair.start", {}, { io: deps.io || realIO })
      : await callAsPerson("link.call", { tool: "relay.pair.start", input: {} }, { io: deps.io || realIO });
    if (r.error && r.error.code === "no_such_tool") return fail("this box has no relay yet", { next: "vyre phone add, with Tailscale on the phone" });
    if (r.error) return failTool(r.error);
    offer = r.data && r.data.url;
    if (r.data && r.data.expiresAt && deps.life === undefined) expires = Number(r.data.expiresAt);
  } else if (t.local) {
    const r = await callAsPerson("presence.code", {}, { io: deps.io || realIO });
    if (r.error) return failTool(r.error);
    code = typeof r.data === "string" ? r.data : r.data && r.data.code;
    if (r.data && r.data.expires && deps.life === undefined) expires = Number(r.data.expires);
  }

  const [ts, tools] = await Promise.all([(deps.tailscale || (() => tailnet.status()))().catch(() => null), request("GET", "/v1/tools")]);
  const relay = list(tools).map(x => String(x.name)).filter(n => n.startsWith("relay."));
  const [d0, k0, r0] = await Promise.all([t.tool("push.devices"), t.tool("presence.keys"), t.tool("relay.devices.list")]);
  if (d0.error) return failTool(d0.error);
  if (k0.error) return failTool(k0.error);
  const before = { devices: list(d0), keys: list(k0), relay: relayDevices(r0) };
  const hasRelay = !r0.error || relay.length > 0;

  const net = {
    kind: "tailscale", tailnet: tailnetOf(address), login: ts && ts.login ? ts.login : null,
    relay: relay.length ? relay : null,
  };
  const install = {
    iphone: "Safari: Share, then Add to Home Screen. Open Vyre from the Home Screen: notifications work only there.",
    android: "Chrome: the menu, then Install app. Or the native app over a cable: vyre phone add --android --usb",
  };
  if (json()) {
    if (offer) return emit({ box: address, url: offer, network: { kind: "relay" }, expires, checks: evaluate(before, before, { address }) });
    return emit({ box: address, url: address + "/", network: net, code, expires,
      install: flags.iphone ? { iphone: install.iphone } : flags.android ? { android: install.android } : install,
      checks: evaluate(before, before, { address }) });
  }

  if (offer) {
    out(`  Pairing a phone with the box through the relay ${dim("(" + hostOf(address) + ")")}`);
    out(dim("  Confirmed · the QR works once, for 10 minutes"));
    out("");
    out(`  1 ${bold("Open Vyre".padEnd(14))}${offer}`);
    if (colour) {
      for (const l of terminal(qr(offer), { indent: "     " })) out(l);
      out(dim("                   Scan this with the phone's camera. No Tailscale needed on the phone"));
    } else out(dim("                   Open this address on the phone (the QR code shows in a colour terminal)"));
    out(`  2 ${bold("Install".padEnd(14))}${dim("Share, then Add to Home Screen (iPhone) · the menu, then Install app (Android)")}`);
    out(`  3 ${bold("Checks")}`);
    return watch(t, { address, before, expires }, deps);
  }
  out(`  Pairing a phone with the box ${dim("(" + hostOf(address) + ")")}`);
  if (code) out(dim("  Confirmed · the code works once, for 10 minutes"));
  out("");
  const pad = s => bold(s.padEnd(14));
  out(`  1 ${pad("Network")}Tailscale${net.tailnet ? ", tailnet " + net.tailnet : ""}`);
  out(dim(`                   Get Tailscale on the phone, and sign in as ${net.login || "the same account as the box"}`));
  out(dim(hasRelay ? "                   Without Tailscale on the phone: vyre phone add --relay"
    : "                   Without Tailscale on the phone: the relay is coming; for now the phone needs Tailscale"));
  out(`  2 ${pad("Open Vyre")}${address}`);
  if (colour) {
    for (const l of terminal(qr(address + "/"), { indent: "     " })) out(l);
    out(dim("                   Scan this with the phone's camera, or type the address"));
  } else out(dim("                   Type this address on the phone (the QR code shows in a colour terminal)"));
  out(code ? `                   ${dim("When it asks for a code (Passkey, Add), type")} ${signal(spaced(code))}`
    : dim("                   The passkey code comes from the box: vyre presence code there, then type it on the phone"));
  const steps = flags.iphone ? [["iPhone", install.iphone]] : flags.android ? [["Android", install.android]] : [["iPhone", install.iphone], ["Android", install.android]];
  out(`  3 ${pad("Install")}${steps[0][0]}: ${steps[0][1]}`);
  for (const [name, how] of steps.slice(1)) out(`                   ${name}: ${how}`);
  out(dim("                   Then on Now: turn on notifications, and add a passkey"));
  out(`  4 ${bold("Checks")}`);

  return watch(t, { address, before, expires }, deps);
}

/**
 * Read push.devices and presence.keys again whenever something may have changed, and test the
 * first new device. Resolves to 0 when the checks pass, 1 when the code runs out.
 */
function watch(t, { address, before, expires }, deps) {
  const tty = deps.tty ?? Boolean(process.stdout.isTTY);
  const input = deps.input !== undefined ? deps.input : process.stdin.isTTY ? process.stdin : null;
  /** @type {{ device: string, sent: number, failed: number } | null} */
  let tested = null;
  let checks = evaluate(before, before, { address });
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
        const now = { devices: d.error ? before.devices : list(d), keys: k.error ? before.keys : list(k), relay: rl.error ? before.relay : relayDevices(rl) };
        const fresh = now.devices.filter(x => !before.devices.some(b => b.device === x.device));
        if (fresh.length && !tested) {
          const r = await t.tool("push.test", { device: fresh[0].device });
          tested = { device: fresh[0].device, sent: r.data ? Number(r.data.sent) || 0 : 0, failed: r.data ? Number(r.data.failed) || 0 : 1 };
        }
        checks = evaluate(before, now, { address, tested });
        if (!done) report();
        if (finished(checks)) {
          const name = (fresh[0] && fresh[0].label) || (now.keys.find(x => !before.keys.some(b => b.id === x.id)) || {}).name || "The phone";
          end(0, `  ${signal("●")} ${name} is ready · ${checks.filter(c => c.state === "ok").length} of 5 checks passed`);
        }
      } finally {
        busy = false;
        if (again && !done) { again = false; check(); }
      }
    };
    const onKey = chunk => { if (/[\r\n]/.test(String(chunk))) check(); };
    const onInt = () => end(0, dim("  stopped watching · vyre phone list shows what arrived"));
    const stopStream = follow(t.local, () => check());
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

/** Run adb: VYRE_ADB_BIN, else adb on PATH, else the Android SDK's. { code: 127 } when none is there. */
function adb(args, env = process.env) {
  const bins = env.VYRE_ADB_BIN ? [env.VYRE_ADB_BIN] : ["adb", path.join(os.homedir(), "Library", "Android", "sdk", "platform-tools", "adb")];
  const one = bin => new Promise(resolve => execFile(bin, args, { timeout: 10_000 }, (e, stdout, stderr) => {
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
 * The APK the box serves the phone. No box serves one yet: the Android build is a CI artifact
 * only. When a box tool or route serves it, this is where `--usb` picks it up.
 * @returns {Promise<string|null>}
 */
async function apk() { return null; }

/** `vyre phone add --android --usb|--wireless`. @param {{ wireless?: boolean }} flags */
export async function android(flags) {
  const how = flags.wireless ? "wireless" : "usb";
  const v = await adb(["version"]);
  if (v.code === 127) return fail("adb is not installed, so Vyre cannot install the app over a cable", { next: "install Android platform-tools (brew install android-platform-tools), or vyre phone add for the web app" });
  const devs = await adb(["devices", "-l"]);
  const found = adbDevices(devs.out).filter(d => d.state === "device" && d.wireless === (how === "wireless"));
  const unauthorized = adbDevices(devs.out).filter(d => d.state === "unauthorized");
  const file = await apk();
  if (!json()) {
    if (found.length) out(dim(`  Found ${found[0].model || found[0].serial} over ${how === "usb" ? "USB" : "Wireless debugging"}`));
    else if (unauthorized.length) out(beacon("  A phone is connected but has not allowed this computer: tap Allow on the phone"));
    else if (how === "usb") out(dim("  No phone over USB: plug it in, and turn on USB debugging in Developer options"));
    else out(dim("  Pair with Wireless debugging: Developer options, Wireless debugging, Pair device with pairing code, then adb pair <ip:port>"));
  }
  if (!file) return fail("the box has no Android app to serve yet, so there is nothing to install", { code: "no_apk", next: "vyre phone add for the web app; the native app comes with a box that serves its APK" });
  return fail("installing over adb is not built yet", { next: "vyre phone add for the web app" });
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
      --relay                  pair through the relay: a single-use QR, no Tailscale on the phone
      --android --usb          the native app over a cable (needs adb and an APK the box serves)
      --android --wireless     the same over Wireless debugging
  vyre phone list              the devices that get notifications, and the passkeys
  vyre phone remove <id>...    forget a notification device, or remove a passkey (asks you first)
  vyre phone test [id]         send a test notification to every device, or one

  add mints a one-time code for the phone's passkey (it asks you first, and lasts 10 minutes),
  then watches until the phone shows up: a new notification device, a test notification the
  push service took, and a new passkey. It checks again every minute and when you press Enter.
  With --json it prints the address, the code and the steps as one JSON value and does not watch.`;

export default {
  name: "phone", order: 46, usage: USAGE, summary: "add a phone to your box, list, remove and test the ones it has", help: HELP,
  async run(args) {
    const { flags, pos } = parse(args, { bool: ["iphone", "android", "usb", "wireless", "relay"], values: [], cmd: "phone" });
    const [sub0 = "list", ...rest] = pos;
    const sub = ({ ls: "list", rm: "remove", pair: "add" })[sub0] || sub0;
    if (sub === "add") {
      if (rest.length) return usage(`vyre phone add takes no words: ${rest.join(" ")}`);
      if ((flags.usb || flags.wireless) && !flags.android) return usage("vyre phone add: --usb and --wireless are for --android", "vyre phone add --android --usb");
      if (flags.usb && flags.wireless) return usage("vyre phone add: --usb or --wireless, not both");
      if (flags.iphone && flags.android) return usage("vyre phone add: --iphone or --android, not both");
      if (flags.relay && (flags.usb || flags.wireless)) return usage("vyre phone add: --relay pairs the web app; --usb and --wireless install the native one");
      if (flags.usb || flags.wireless) return android(flags);
      return add(flags);
    }
    if (sub === "list") return listPhones();
    if (sub === "remove") return remove(rest);
    if (sub === "test") return testPush(rest[0]);
    return usage(`vyre phone ${sub}: not a subcommand`, "vyre phone add, list, remove <id> or test [id]");
  },
};
