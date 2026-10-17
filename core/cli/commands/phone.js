// @ts-check
// `vyre phone`: put a phone on the box, and look after the phones it has.
//
//   vyre phone add                         says how a phone joins now: it signs in with the person's name and is approved on a
//                                          device they already use (the classic pairing code is gone, 13 Oct 2026)
//   vyre phone add --android --usb         the native app over a cable (adb); --wireless for
//                                          Wireless debugging. The APK comes from the box
//   vyre phone list                        the devices that get notifications, and the passkeys
//   vyre phone remove <id>...              forget a notification device or remove a passkey
//   vyre phone test [id]                   send a test notification
//
// On a box every call is local; on a Mac linked to a box the reads go over link.call. Removing a
// passkey needs presence on the box itself, which a Mac cannot give over the link (a passkey is the
// only proof the box takes from another machine, ADR 0004), so from a Mac it points at the box or the Deck.
// The relay tools (ADR 0026) are found by trying them: a box without the relay module answers
// no_such_tool, and everything here works without them.
//
// The native Android app: the box's releases module serves <box>/v1/releases/android (version,
// sha, sha256, size, minSdk, file) and the APK at <box>/v1/releases/android?file=<file>. CI builds and signs it; the box and
// this command never re-sign. --usb and --wireless download it from the box, check its size
// and sha256 and install it with adb.
//
// --json shapes: add --android --usb {phone, version, sha, installed, pair} · list {devices, passkeys, relay}
// · remove {removed:[{id, kind}]} · test {sent, failed, dropped}.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { call } from "../../daemon/client.js";
import * as config from "../../config/index.js";
import { callAsPerson } from "../presence.js";
import { personIO } from "./presence.js";
import { qr, terminal } from "../qr.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { EXIT, json, emit, fail, failTool, usage, parse } from "../kit.js";
import { userHostFetch } from "../../../lib/http.js";

const USAGE = "vyre phone [add --android [--usb|--wireless]|list|remove <id...>|test [id]] [--json]";

/** What a phone does to join now, shown where the pairing code used to be. */
const SIGN_IN = "Open Vyre on the phone and sign in with your space address, your username and your master password";

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
/** A code is typed by hand: shown in fours, and the box ignores the dash. */
const spaced = c => String(c).replace(/(.{4})(?=.)/g, "$1-");
const list = r => (Array.isArray(r.data) ? r.data : []);
/** relay.devices.list's devices, or [] when the box has no relay (no_such_tool) or it fails. */
const relayDevices = r => (r && r.data && Array.isArray(r.data.devices) ? r.data.devices : []);

// ------------------------------------------------------------ the checks

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
 * The Android app the box serves: GET <box>/v1/releases/android. One fetch, no retries.
 * { manifest } when it serves one; { missing } for a 404, a box without the route, or a manifest
 * that is not whole; { error } when the box did not answer at all.
 * @param {string} base @param {typeof fetch} [f]
 * @returns {Promise<{ manifest?: AppManifest, missing?: boolean, error?: string }>}
 */
export async function appManifest(base, f = userHostFetch) {
  let r;
  try { r = await f(`${base}/v1/releases/android`, { cache: "no-store", signal: AbortSignal.timeout(8000) }); }
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
 * @returns {Promise<{ file?: string, dir?: string, mismatch?: "size"|"sha256"|"box", missing?: boolean, error?: string }>}
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
    // 409: the box's own copy does not match CI's android.json, so it refuses to serve it.
    if (r.status === 409) { drop(); return { mismatch: "box" }; }
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
 *   target?: () => Promise<Awaited<ReturnType<typeof target>>> }} AndroidDeps
 */

/**
 * `vyre phone add --android --usb|--wireless`: the native app from the box, installed over adb,
 * then left for the person to sign in on. deps are for tests: fetch, the box's base URL and the target.
 * @param {{ wireless?: boolean }} flags @param {AndroidDeps} [deps]
 */
export async function android(flags, deps = {}) {
  const how = flags.wireless ? "wireless" : "usb";
  const f = deps.fetch || userHostFetch;
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
  if (got.error) return fail(`could not reach the box at ${hostOf(base)} for the app: ${got.error}`, { code: "unreachable", next: "check this computer's connection to the server, then again" });
  if (!got.manifest) return noApk();
  const m = got.manifest;

  const sdk = Number((await adb(["-s", phone.serial, "shell", "getprop", "ro.build.version.sdk"])).out.trim());
  if (m.minSdk && Number.isFinite(sdk) && sdk > 0 && sdk < Number(m.minSdk)) {
    return fail(`${model} runs Android API level ${sdk}, and Vyre ${m.version} needs ${m.minSdk} or newer`, { code: "too_old", next: "vyre phone add for the web app, which works in Chrome" });
  }

  const dl = await download(`${base}/v1/releases/android?file=${encodeURIComponent(apkName(m))}`, m, f);
  if (dl.missing) return noApk();
  if (dl.error) return fail(`the download from ${hostOf(base)} stopped: ${dl.error}`, { code: "download_failed", next: "vyre phone add --android --" + how + " again" });
  if (dl.mismatch === "box") return fail("the box's copy of the app does not match what CI built, so it will not serve it; nothing was installed", { code: "release_mismatch", next: "vyre update fetches the release again" });
  if (dl.mismatch) return fail(`the APK's ${dl.mismatch} is not what the box says: the download was not what the box says it built; nothing was installed`, { code: "mismatch", next: "vyre phone add --android --" + how + " again; if it repeats, the box's app build needs a look" });

  const result = { phone: { serial: phone.serial, model: phone.model, via: how }, version: m.version, sha: m.sha || null, installed: false };
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

  // Nothing pairs here: the classic pairing code is gone (13 Oct 2026). The person signs in on the phone with their name and approves it from a device they already use.
  if (json()) return emit({ ...result, pair: SIGN_IN });
  out(dim("  " + SIGN_IN));
  return 0;
}

// ------------------------------------------------------------ list, remove, test

export async function listPhones() {
  const t = await target();
  if (!t) return EXIT.FAILED;
  const [d, k, rl] = await Promise.all([t.tool("push.devices"), t.tool("presence.keys"), t.tool("relay.devices.list")]);
  if (d.error) return failTool(d.error);
  if (k.error) return failTool(k.error);
  const devices = list(d), passkeys = list(k).filter(x => x.kind === "passkey"), relayed = relayDevices(rl);
  if (json()) {
    const on = ms => (ms ? new Date(ms).toISOString().slice(0, 10) : "");
    const rows = [
      ...devices.map(x => ({ id: String(x.device), name: x.label || "", kind: "notifications", added: on(x.at), note: [x.service, x.fails ? `${x.fails} failed` : ""].filter(Boolean).join(" · ") })),
      ...relayed.map(x => ({ id: String(x.id), name: x.name || "", kind: "relay", added: on(x.pairedAt), note: x.online ? (x.path === "relay" ? "online through the relay" : "online") : "offline" })),
      ...passkeys.map(x => ({ id: String(x.id), name: x.name || "", kind: "passkey", added: on(x.created), note: x.last_used ? "last used " + on(x.last_used) : "" })),
    ];
    return emit({ devices, passkeys, relay: relayed }, { kind: "table", title: "Phones", empty: "No phones yet · vyre phone add", rows,
      columns: [{ key: "name", label: "Name" }, { key: "kind", label: "Kind" }, { key: "id", label: "Id" }, { key: "added", label: "Added" }, { key: "note", label: "Note" }] });
  }
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
      const r = t.local ? await callAsPerson("relay.devices.remove", { id }, { io: deps.io || personIO() })
        : await callAsPerson("link.call", { tool: "relay.devices.remove", input: { id } }, { io: deps.io || personIO() });
      if (r.error) return failTool(r.error);
      removed.push({ id, kind: "relay" });
    } else if (list(d).some(x => x.device === id)) {
      const r = await t.tool("push.unsubscribe", { device: id });
      if (r.error) return failTool(r.error);
      removed.push({ id, kind: "device" });
    } else if (list(k).some(x => x.id === id)) {
      // Removing a passkey needs presence on the box; a Mac cannot give it over the link.
      if (!t.local) return fail(`${id} is a passkey, and removing one needs you at the box`, { next: `vyre phone remove ${id} on the box, or remove it in the Deck` });
      const r = await callAsPerson("presence.remove", { id }, { io: deps.io || personIO() });
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
  const { sent = 0, failed = 0, dropped = 0 } = r.data || {};
  if (json()) {
    emit(r.data, { kind: "card", title: "Test notification", state: sent ? "ok" : "failed", fields: [{ label: "Sent to", value: `${sent} device${sent === 1 ? "" : "s"}` },
      ...(failed ? [{ label: "Failed", value: String(failed) }] : []), ...(dropped ? [{ label: "Gone and forgotten", value: String(dropped) }] : [])] });
    return sent || !failed ? 0 : EXIT.FAILED;
  }
  out(`  ${sent ? signal("●") : beacon("○")} sent to ${sent} device${sent === 1 ? "" : "s"}${failed ? beacon(` · ${failed} failed`) : ""}${dropped ? dim(` · ${dropped} gone and forgotten`) : ""}`);
  if (sent) out(dim("  The push service took it; check the phone shows \"Vyre can reach this device\"."));
  return sent || !failed ? 0 : EXIT.FAILED;
}

// ------------------------------------------------------------ the command

const HELP = `
  vyre phone add --android --usb      the native app over a cable: downloads the APK the box serves,
                                      checks its size and sha256 and installs it with adb
  vyre phone add --android --wireless the same over Wireless debugging
  vyre phone list                     the devices that get notifications, and the passkeys
  vyre phone remove <id>...           forget a notification device, or remove a passkey (asks you first)
  vyre phone test [id]                send a test notification to every device, or one

  A phone joins by signing in with your space address, your username and your master password.
  The old pairing code is gone, so add installs the app and says so; it pairs nothing.`;

export default {
  name: "phone", order: 46, usage: USAGE, summary: "install the app on a phone, list, remove and test the phones the box has", help: HELP,
  verbs: [
    { verb: "add", aliases: ["pair"], summary: "install the Android app over adb; a phone joins by signing in with your name", usage: "[--android] [--usb] [--wireless]" },
    { verb: "list", aliases: ["ls"], summary: "the devices that get notifications, and the passkeys", usage: "", read: true },
    { verb: "remove", aliases: ["rm"], summary: "forget a notification device, or remove a passkey", usage: "<id...>", person: true },
    { verb: "test", summary: "send a test notification to every device, or one", usage: "[id]" },
  ],
  async run(args) {
    const { flags, pos } = parse(args, { bool: ["iphone", "android", "usb", "wireless", "relay"], values: [], cmd: "phone" });
    const [sub0 = "list", ...rest] = pos;
    const sub = ({ ls: "list", rm: "remove", pair: "add" })[sub0] || sub0;
    if (sub === "add") {
      if (rest.length) return usage(`vyre phone add takes no words: ${rest.join(" ")}`);
      if ((flags.usb || flags.wireless) && !flags.android) return usage("vyre phone add: --usb and --wireless are for --android", "vyre phone add --android --usb");
      if (flags.usb && flags.wireless) return usage("vyre phone add: --usb or --wireless, not both");
      if (flags.iphone && flags.android) return usage("vyre phone add: --iphone or --android, not both");
      if (flags.usb || flags.wireless) return android(flags);
      return fail("a phone is not added from here any more: the pairing code is gone, because a code anyone could hold made devices nobody confirmed",
        { next: "on the phone, sign in with your space address, your username and your master password. To put the Android app on it over a cable: vyre phone add --android --usb" });
    }
    if (sub === "list") return listPhones();
    if (sub === "remove") return remove(rest);
    if (sub === "test") return testPush(rest[0]);
    return usage(`vyre phone ${sub}: not a subcommand`, "vyre phone add, list, remove <id> or test [id]");
  },
};
