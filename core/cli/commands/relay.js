// @ts-check
// `vyre relay`: reach the box with a QR code, no Tailscale (ADR 0026). Status, pairing with a code
// drawn in the terminal, the device list, and turning it on and off. Every change goes through
// the person at this terminal (presence), like the same buttons in the Deck.

import { call } from "../../daemon/client.js";
import { ensureUp } from "../daemonctl.js";
import { callAsPerson } from "../presence.js";
import { out, dim, bold } from "../style.js";
import { json, emit, fail, failTool, usage, parse } from "../kit.js";
import { qrcode } from "../../../deck/vendor/qrcode.js";

const USAGE = "vyre relay [status|pair|devices|remove <id>|rename <id> <name>|trust <id> [--off]|on [--url u]|off|pin <release>|unpin] [--json]";

/**
 * A QR code in terminal half blocks, two rows of modules per line, with the quiet zone the spec
 * asks for. Light modules are drawn, so it scans on a dark terminal; phone cameras read the
 * inverted code on a light one too.
 * @param {string} text
 */
export function terminalQr(text) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), pad = 2;
  const light = (r, c) => r < 0 || c < 0 || r >= n || c >= n || !q.isDark(r, c);
  const lines = [];
  for (let r = -pad; r < n + pad; r += 2) {
    let line = "";
    for (let c = -pad; c < n + pad; c++) {
      const top = light(r, c), bottom = light(r + 1, c);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** "3h ago" and the like. */
const ago = (ms, now = Date.now()) => {
  if (!ms) return "never";
  const s = Math.max(0, (now - ms) / 1000);
  return s < 90 ? "just now" : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};

async function up() {
  const r = await ensureUp();
  if (!r.ok) fail("vyred did not start", { code: "unreachable", exit: 5, next: `its output is in ${r.log}` });
  return r.ok;
}

/** A tool as the person at this terminal, then print or emit. */
async function asPerson(tool, input, show) {
  const r = await callAsPerson(tool, input);
  if (r.error) return failTool(r.error);
  if (json()) return emit(r.data);
  show(r.data);
  return 0;
}

async function status() {
  const r = await call("relay.status");
  if (r.error) return failTool(r.error);
  const d = r.data;
  if (json()) return emit(d);
  out(`  relay ${d.enabled ? (d.connected ? bold("connected") : "on, not connected yet") : "off"} ${dim(`· ${d.url}`)}`);
  out(dim(`  ${d.devices} device${d.devices === 1 ? "" : "s"} paired · ${d.open} open now${d.route ? ` · route ${d.route}` : ""}`));
  if (!d.devices) out(dim("  vyre relay pair to add your phone"));
  return 0;
}

async function devices() {
  const r = await call("relay.devices.list");
  if (r.error) return failTool(r.error);
  if (json()) return emit(r.data);
  if (!r.data.devices.length) { out("  no devices paired through the relay"); out(dim("  vyre relay pair to add one")); return 0; }
  for (const d of r.data.devices) {
    const kind = d.kind === "web" ? `web app${d.trusted ? ", trusted" : ""}${d.build === "unknown" ? ", unknown build" : d.release ? `, ${d.release}` : ""}` : "app";
    out(`  ${bold(d.name)} ${dim(d.id)}`);
    out(dim(`    ${kind} · ${d.online ? `connected (${d.path})` : `last seen ${ago(d.lastSeen)}`} · paired ${ago(d.pairedAt)}${d.presence ? " · presence key" : ""}`));
  }
  return 0;
}

export default [
  {
    name: "relay", order: 46, usage: USAGE,
    help: "vyre relay: whether the relay is on and connected\nvyre relay pair: a QR code for one more device (once, 10 minutes)\nvyre relay devices: paired devices, which are connected, and how\nvyre relay remove|rename|trust: manage one (a browser from the web app is limited until trusted)\nvyre relay on|off, pin <release>|unpin: the relay itself, and which web app build this box trusts",
    summary: "reach this box from your phone with a QR code, no Tailscale",
    async run(args) {
      const { flags, pos } = parse(args, { bool: ["off"], values: ["url"], cmd: "relay" });
      const [verb = "status", a, ...rest] = pos;
      if (!(await up())) return 5;
      switch (verb) {
        case "status": return status();
        case "devices": return devices();
        case "pair":
          return asPerson("relay.pair.start", {}, d => {
            out("\n" + terminalQr(d.url).split("\n").map(l => "  " + l).join("\n") + "\n");
            out("  Scan this with your phone's camera. It works once, for 10 minutes.");
            out(dim(`  ${d.url}`));
            if (!d.connected) out(dim("  the box is not at the relay yet; the code works as soon as it is (vyre relay)"));
          });
        case "remove":
          if (!a) return usage("vyre relay remove needs a device id", "vyre relay devices lists them");
          return asPerson("relay.devices.remove", { id: a }, () => out(`  removed ${a}; its connections are closed`));
        case "rename":
          if (!a || !rest.length) return usage("vyre relay rename needs an id and a name", "vyre relay rename <id> <name>");
          return asPerson("relay.devices.rename", { id: a, name: rest.join(" ") }, d => out(`  ${d.id} is now ${bold(d.name)}`));
        case "trust":
          if (!a) return usage("vyre relay trust needs a device id", "vyre relay devices lists them");
          return asPerson("relay.devices.trust", { id: a, trusted: !flags.off }, d => out(`  ${d.id} ${d.trusted ? "has the full powers of your app" : "is limited again"}`));
        case "on":
          return asPerson("relay.enable", flags.url ? { url: String(flags.url) } : {}, d => out(`  relay on ${dim(`· ${d.url}`)}`));
        case "off":
          return asPerson("relay.disable", {}, () => out("  relay off; paired devices stay paired"));
        case "pin":
          if (!a) return usage("vyre relay pin needs a release", "vyre relay pin 0.4.2, or vyre relay unpin");
          return asPerson("relay.web.pin", { release: a }, d => out(`  the web app is pinned to ${d.pinned}`));
        case "unpin":
          return asPerson("relay.web.pin", { release: "" }, () => out("  the web app follows the newest release this box knows"));
        default:
          return usage(`vyre relay ${verb} is not a thing`, USAGE);
      }
    },
  },
];
