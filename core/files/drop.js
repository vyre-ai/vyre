// @ts-check
// drop: send a file between the Mac and the box with Taildrop, and take it in at the other end.
//
// files.fetch brings a box file down through the link, a chunk at a time. Going the other way,
// Tailscale already moves whole files between a person's own devices (Taildrop), peer to peer and
// fast, so the sending machine hands the file to `tailscale file cp` and the other collects it.
// Only what the files guard passes may leave a machine: a key or an .env is refused before
// Tailscale sees it.
//
// Mac to box (files.send) is the original direction. Box to a paired Mac (files.deliver, ADR
// 0021 "Mac and box as one") is the reverse: the box looks up the Mac's tailnet peer id from
// link.macs (its stableId, not its name, since a name can be reused) rather than a single
// link.status the way the Mac finds its one paired box.
//
// On the receiving side, one child process, `tailscale file get --wait --loop`, moves each
// arriving file into that machine's inbox (the box's /work/inbox, or a Mac's ~/Vyre/inbox). It
// blocks inside tailscaled until a file comes, so an idle machine spends nothing on it. A
// received file is someone else's bytes: the event names it, and nothing here opens or runs it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { run as tailscale } from "../names/tailscale.js";
import { tailscaleBin } from "../link/transport.js";

/** The box's inbox when config files.inbox is not set: inside /work, the box's default root. */
export const INBOX = "/work/inbox";
/** A Mac's inbox when config files.inbox is not set: inside its home, a Mac's default root. */
export const macInbox = () => path.join(os.homedir(), "Vyre", "inbox");
/** How long one send may take. Taildrop is peer to peer; a large file on a slow uplink is slow. */
const SEND_TIMEOUT = 60 * 60_000;
/** The floor for recurring timers (SPEC principle 8): how often the box looks at Tailscale again. */
const RETRY = 60_000;

/**
 * ipnstate.TaildropTargetStatus, as `tailscale status --json` numbers it, in plain words. 1 is
 * "available"; 0 is what a Tailscale too old to say reports, and then NoFileSharingReason decides.
 */
const TARGET = {
  2: "Tailscale on this Mac has no map of the tailnet yet: is it signed in?",
  3: "Tailscale on this Mac is not running",
  4: "your tailnet does not allow Taildrop to the box (the Taildrop feature is off, or a rule is missing)",
  5: "the box is offline on the tailnet",
  6: "Tailscale has no details about the box yet",
  7: "the box's operating system cannot receive Taildrop files",
  8: "the box's Tailscale does not accept files (it has no peer API)",
  9: "the box belongs to another login or is a tagged device, and Taildrop sends only to your own devices",
};

/**
 * Why Taildrop cannot reach this peer, in plain words, or null when it can. Pure, for tests.
 * @param {any} peer one entry of `tailscale status --json` Peer
 * @returns {string|null}
 */
export function unavailable(peer) {
  const tagged = Array.isArray(peer.Tags) && peer.Tags.length > 0;
  const code = Number(peer.TaildropTarget) || 0;
  const reason = String(peer.NoFileSharingReason || "").trim();
  if (code === 1 && !reason) return null;
  if (code === 0 && !reason) return null;
  let why = TARGET[code] || reason || `Taildrop cannot reach the box (status ${code})`;
  if (reason && TARGET[code] && !why.includes(reason)) why += ` (Tailscale says: ${reason})`;
  // A tagged box is the usual case: tagging it takes it out of the owner's devices.
  if (tagged && code !== 9) why += "; the box is a tagged device, and Taildrop sends only to your own devices unless the tailnet grants it";
  return why;
}

/**
 * The file a --verbose `tailscale file get` line reports, or null. It prints
 * `wrote <name> as <path> (<n> bytes)`, where path is inside the directory it was given. The
 * directory is looked for, so a name with " as " in it still parses.
 * @param {string} line @param {string} dir the inbox as it was passed to the child
 * @returns {{ file: string, bytes: number } | null}
 */
export function parseWrote(line, dir) {
  const m = /\((\d+) bytes\)\s*$/.exec(line);
  if (!m || !/\bwrote /.test(line)) return null;
  const head = line.slice(0, m.index).trimEnd();
  const at = head.lastIndexOf(" as " + dir + path.sep);
  const file = at >= 0 ? head.slice(at + 4) : null;
  if (!file) return null;
  return { file, bytes: Number(m[1]) };
}

const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

/**
 * Register both tools and the inbox receiver for this machine's role: on the Mac, files.send
 * always, and an inbox for what the box delivers only when files.receive is on (e2e review of
 * 0c645473, MEDIUM: without a switch, every Mac would take over the user's whole Tailscale file
 * flow — every device's Taildrop, not only the box's deliveries — the moment it upgrades, with no
 * choice in it). On the box, files.deliver and its existing inbox for what a Mac sends.
 * @param {any} ctx the files module's context
 * @param {{ role: "box"|"local", g: ReturnType<typeof import("./safety.js").guard>, cfg: any }} opts
 * @returns {{ stop(): Promise<void> }}
 */
export function drop(ctx, { role, g, cfg }) {
  if (role === "local") {
    sender(ctx, g);
    // Exactly true, not merely truthy: a config value read back as the string "false" (a shell
    // export, a stray env override) must not switch the receiver on (e2e review of aa9cb40c).
    if (cfg.receive !== true) return { async stop() {} };
    return receiver(ctx, g, cfg, macInbox());
  }
  boxSender(ctx, g);
  return receiver(ctx, g, cfg, INBOX);
}

/** The Mac's half: one tool that hands a checked file to `tailscale file cp`. */
function sender(ctx, g) {
  const unable = message => Object.assign(new Error(message), { code: "taildrop_unavailable" });

  ctx.tool("files.send", {
    description: "Send a file from this Mac to your box with Taildrop. It lands in the box's inbox folder. Secrets and dotfiles are refused.",
    input: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    callers: ["cli", "capsule", "local"],
    run: async ({ path: p }) => {
      const safe = g.resolveSafe(p);
      const st = fs.statSync(safe.real);
      if (!st.isFile()) throw new Error("only a file can be sent, not a folder");
      // The paired box, as the link module saved it. Its stable ID is what finds it among the
      // peers: a name can be reused by another device, the ID cannot.
      const link = await ctx.call("link.status", {});
      const box = link.data && link.data.linked ? link.data.box : null;
      if (!box || !box.stableId) throw Object.assign(new Error("this Mac is not paired with a box (vyre link pair <address>)"), { code: "no_link" });
      const s = await tailscale(["status", "--json"]);
      if (s.code === 127) throw unable("Tailscale is not installed on this Mac");
      let status;
      try { status = JSON.parse(s.out); } catch { throw unable((s.err || s.out).trim().split("\n")[0] || "tailscale status failed"); }
      if (status.BackendState !== "Running") throw unable(`Tailscale on this Mac is ${status.BackendState === "NeedsLogin" ? "signed out" : status.BackendState || "not running"}`);
      const peer = Object.values(status.Peer || {}).find(x => String(x.ID || "") === box.stableId);
      if (!peer) throw unable("the box is not among this Mac's tailnet peers");
      const why = unavailable(peer);
      if (why) throw unable(why);
      const ip = (peer.TailscaleIPs || []).find(a => !String(a).includes(":")) || (peer.TailscaleIPs || [])[0];
      if (!ip) throw unable("the box has no tailnet address");
      const node = String(peer.DNSName || "").replace(/\.$/, "") || box.node || String(peer.HostName || "");
      // The real path: the guard checked it, and a symlink is not followed a second time. Taildrop
      // names the file on the box after it.
      const r = await tailscale(["file", "cp", safe.real, `${ip}:`], { timeout: SEND_TIMEOUT });
      if (r.code !== 0) throw Object.assign(new Error((r.err || r.out).trim().split("\n").slice(-1)[0] || "tailscale file cp failed"), { code: "send_failed" });
      const name = path.basename(safe.real);
      // The file has gone either way; an event the log turns away does not make the send fail.
      try { ctx.events.emit("files.sent", { name, bytes: st.size, to: node }); } catch {}
      return { sent: name, bytes: st.size, to: node };
    },
  });
}

/**
 * The box's half of the reverse direction: hand a checked file to `tailscale file cp` at one
 * paired Mac's tailnet address. Unlike the Mac's sender, which has exactly one paired box
 * (link.status), a box may have several paired Macs, so the caller names one (mac: its id or
 * name, as link.macs lists it).
 */
function boxSender(ctx, g) {
  const unable = message => Object.assign(new Error(message), { code: "taildrop_unavailable" });

  ctx.tool("files.deliver", {
    description: "Send a file from the box to a paired Mac with Taildrop. It lands in the Mac's inbox folder (~/Vyre/inbox) only once that Mac has turned files.receive on; otherwise Tailscale holds it unclaimed. A Mac paired without its node known (no_link) needs pairing again. Secrets and dotfiles are refused.",
    input: { type: "object", required: ["path", "mac"], properties: { path: { type: "string" }, mac: { type: "string", description: "A paired Mac's id or name (link.macs, vyre link)." } } },
    // No "module": a home module has no first-party need to push box files onto the user's Mac,
    // and it is the person's own choice each time (e2e review of 0c645473, LOW).
    callers: ["cli", "local", "deck", "capsule"],
    run: async ({ path: p, mac: which }) => {
      const safe = g.resolveSafe(p);
      const st = fs.statSync(safe.real);
      if (!st.isFile()) throw new Error("only a file can be sent, not a folder");
      const macs = await ctx.call("link.macs", {});
      const row = (macs.data || []).find(/** @param {any} m */ m => m.mac === which || m.name === which);
      if (!row) throw Object.assign(new Error(`no paired Mac named "${which}" (vyre link)`), { code: "no_link" });
      // stableId is set once the Mac's node is known (pairing saves it); a Mac paired before that
      // has none, the same gap link.macs.call's Mac-forwarded writes hit (core/link/box.js).
      if (!row.stableId) throw Object.assign(new Error(`"${row.name}" paired without its node known; pair it again to send it files`), { code: "no_link" });
      const s = await tailscale(["status", "--json"]);
      if (s.code === 127) throw unable("Tailscale is not installed on this box");
      let status;
      try { status = JSON.parse(s.out); } catch { throw unable((s.err || s.out).trim().split("\n")[0] || "tailscale status failed"); }
      if (status.BackendState !== "Running") throw unable(`Tailscale on this box is ${status.BackendState === "NeedsLogin" ? "signed out" : status.BackendState || "not running"}`);
      const peer = Object.values(status.Peer || {}).find(/** @param {any} x */ x => String(x.ID || "") === row.stableId);
      if (!peer) throw unable(`"${row.name}" is not among this box's tailnet peers`);
      const why = unavailable(peer);
      if (why) throw unable(why);
      const ip = (peer.TailscaleIPs || []).find(/** @param {string} a */ a => !String(a).includes(":")) || (peer.TailscaleIPs || [])[0];
      if (!ip) throw unable(`"${row.name}" has no tailnet address`);
      const node = String(peer.DNSName || "").replace(/\.$/, "") || row.node || String(peer.HostName || "");
      const r = await tailscale(["file", "cp", safe.real, `${ip}:`], { timeout: SEND_TIMEOUT });
      if (r.code !== 0) throw Object.assign(new Error((r.err || r.out).trim().split("\n").slice(-1)[0] || "tailscale file cp failed"), { code: "send_failed" });
      const name = path.basename(safe.real);
      try { ctx.events.emit("files.sent", { name, bytes: st.size, to: node, mac: row.mac }); } catch {}
      return { sent: name, bytes: st.size, to: node, mac: row.mac };
    },
  });
}

/** Either machine's half: one long-lived `tailscale file get --loop`, while Tailscale is running. */
function receiver(ctx, g, cfg, defaultInbox) {
  const log = (m, x) => { if (ctx.log) ctx.log(m, x); };
  let stopped = false;
  /** @type {import("node:child_process").ChildProcess|null} */
  let child = null;
  /** @type {NodeJS.Timeout|null} */
  let timer = null;
  /** @type {Promise<void>|null} */
  let exited = null;

  const inbox = path.resolve(String(cfg.inbox || defaultInbox));

  /**
   * The inbox, made if missing, or null when it cannot be one. It must sit inside a files root and
   * pass the guard, so files.search and files.preview see what arrives. Checked before anything is
   * made, so a bad setting never creates a folder outside the roots.
   */
  function prepare() {
    const rs = g.roots();
    if (!rs.live.some(r => inside(inbox, r.given) || inside(inbox, r.real))) {
      log(`the inbox ${inbox} is not inside a files root, so nothing is received`);
      return null;
    }
    try {
      fs.mkdirSync(inbox, { recursive: true, mode: 0o700 });
      const safe = g.resolveSafe(inbox, g.roots());
      if (!fs.statSync(safe.real).isDirectory()) throw new Error("not a folder");
      return safe.real;
    } catch {
      log(`the inbox ${inbox} is not a folder the files guard allows, so nothing is received`);
      return null;
    }
  }

  const later = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = null; begin(); }, RETRY);
    timer.unref();
  };

  /** Look at Tailscale once; start the child when it is running, otherwise look again later. */
  async function begin() {
    if (stopped || child) return;
    const s = await tailscale(["status", "--json"]);
    if (stopped || child) return;
    if (s.code === 127) return; // no Tailscale on this box: nothing to wait for
    let backend = null;
    try { backend = JSON.parse(s.out).BackendState; } catch {}
    if (backend !== "Running") { later(); return; }
    const dir = prepare();
    if (!dir) return;
    const bin = tailscaleBin();
    if (!bin) return;
    const c = spawn(bin, ["file", "get", "--wait", "--loop", "--conflict=rename", "--verbose", dir], { stdio: ["ignore", "pipe", "pipe"] });
    child = c;
    let done = () => {};
    exited = new Promise(resolve => { done = resolve; });
    const over = why => {
      done();
      if (child !== c) return;
      child = null;
      // tailscaled restarted or signed out: look again in a minute, never in a tight loop.
      if (!stopped) { log(`tailscale file get stopped (${why}); looking again in a minute`); later(); }
    };
    c.on("error", e => over(e.message));
    c.once("close", code => over(`exit ${code}`));
    // --verbose names each file once it is fully written, with its final name after a rename on a
    // clash. Watching the folder instead would fire while a file is still being written, and for
    // anything else that appears there, so the line is the signal.
    const lines = stream => {
      let buf = "";
      stream.setEncoding("utf8");
      stream.on("data", chunk => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) { got(buf.slice(0, i), dir); buf = buf.slice(i + 1); }
        if (buf.length > 64 * 1024) buf = "";
      });
    };
    lines(c.stdout);
    lines(c.stderr);
  }

  function got(line, dir) {
    const w = parseWrote(line, dir);
    if (!w || stopped) return;
    const full = path.resolve(w.file);
    if (!inside(full, dir) || full === dir) return;
    let bytes = w.bytes;
    try { bytes = fs.lstatSync(full).size; } catch {}
    // The name is the sender's choice. One the event log turns away (it looks like a secret) must
    // not take vyred down from inside a stream handler; the file is in the inbox all the same.
    try { ctx.events.emit("files.received", { name: path.basename(full), path: path.relative(dir, full), bytes }); }
    catch (e) { log(`a received file was not announced: ${/** @type {Error} */ (e).message}`); }
  }

  begin().catch(e => log(`the Taildrop inbox did not start: ${/** @type {Error} */ (e).message}`));

  return {
    async stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      const c = child;
      if (!c) return;
      c.kill("SIGTERM");
      const hard = setTimeout(() => { try { c.kill("SIGKILL"); } catch {} }, 2000);
      await exited;
      clearTimeout(hard);
    },
  };
}
