// @ts-check
// `vyre relay`: reach the box with a QR code (ADR 0026). Status, pairing with a code
// drawn in the terminal, the device list, and turning it on and off. Every change goes through
// the person at this terminal (presence), like the same buttons in the Deck.
//
// --json shapes: status {enabled, connected, url, devices, open, route?} · devices {devices:[{id,
// name, kind, online, path, trusted, release, lastSeen, pairedAt, presence}]} · pair {url,
// connected, expiresAt?} (under --view a qr frame of the url) · the changes, the tool's own data.

import { call } from "../../daemon/client.js";
import { ensureUp } from "../daemonctl.js";
import { callAsPerson } from "../presence.js";
import { OFFER_NOTE } from "../offer-note.js";
import { personIO } from "./presence.js";
import { out, dim, bold, colour } from "../style.js";
import { json, emit, fail, failTool, usage, parse } from "../kit.js";
import { qr, terminal } from "../qr.js";

const USAGE = "vyre relay [status|pair|devices|remove <id>|rename <id> <name>|trust <id> [--off]|on [--url u]|off|pin <release>|unpin] [--json]";

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

/** A tool as the person at this terminal, then print or emit (with `view` under --view). */
async function asPerson(tool, input, show, view) {
  const r = await callAsPerson(tool, input, { io: personIO() });
  if (r.error) return failTool(r.error);
  if (json()) return emit(r.data, view ? view(r.data) : undefined);
  show(r.data);
  return 0;
}

async function status() {
  const r = await call("relay.status");
  if (r.error) return failTool(r.error);
  const d = r.data;
  if (json()) {
    return emit(d, { kind: "card", title: "Relay", state: d.enabled ? (d.connected ? "ok" : "wait") : "off", fields: [
      { label: "Relay", value: d.enabled ? (d.connected ? "connected" : "on, not connected yet") : "off" }, { label: "Address", value: String(d.url || "") },
      { label: "Devices", value: String(d.devices ?? 0) }, { label: "Open now", value: String(d.open ?? 0) }, ...(d.route ? [{ label: "Route", value: String(d.route) }] : [])] });
  }
  out(`  relay ${d.enabled ? (d.connected ? bold("connected") : "on, not connected yet") : "off"} ${dim(`· ${d.url}`)}`);
  out(dim(`  ${d.devices} device${d.devices === 1 ? "" : "s"} paired · ${d.open} open now${d.route ? ` · route ${d.route}` : ""}`));
  if (!d.devices) out(dim("  vyre relay pair to add your phone"));
  return 0;
}

async function devices() {
  const r = await call("relay.devices.list");
  if (r.error) return failTool(r.error);
  if (json()) {
    return emit(r.data, { kind: "table", title: "Relay devices", empty: "No devices paired through the relay", rows: r.data.devices,
      columns: [{ key: "name", label: "Name" }, { key: "id", label: "Id" }, { key: "kind", label: "Kind" }, { key: "online", label: "Online" }, { key: "trusted", label: "Trusted" }, { key: "lastSeen", label: "Last seen" }] });
  }
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
    verbs: [
      { verb: "status", summary: "whether the relay is on and connected", usage: "", read: true },
      { verb: "pair", summary: "a QR code for one more device (once, 10 minutes)", usage: "", person: true },
      { verb: "devices", summary: "paired devices, which are connected, and how", usage: "", read: true },
      { verb: "remove", summary: "forget a device and close its connections", usage: "<id>", person: true },
      { verb: "rename", summary: "give a device a name", usage: "<id> <name...>", person: true },
      { verb: "trust", summary: "give a web app browser the full powers of your app, or take them back", usage: "<id> [--off]", person: true },
      { verb: "on", summary: "turn the relay on", usage: "[--url u]", person: true },
      { verb: "off", summary: "turn the relay off; paired devices stay paired", usage: "", person: true },
      { verb: "pin", summary: "trust one web app release", usage: "<release>", person: true },
      { verb: "unpin", summary: "follow the newest web app release this box knows", usage: "", person: true },
    ],
    help: "vyre relay: whether the relay is on and connected\nvyre relay pair: a QR code for one more device (once, 10 minutes)\nvyre relay devices: paired devices, which are connected, and how\nvyre relay remove|rename|trust: manage one (a browser from the web app is limited until trusted)\nvyre relay on|off, pin <release>|unpin: the relay itself, and which web app build this box trusts",
    summary: "reach this box from your phone with a QR code",
    async run(args) {
      const { flags, pos } = parse(args, { bool: ["off"], values: ["url"], cmd: "relay" });
      const [verb = "status", a, ...rest] = pos;
      if (!(await up())) return 5;
      switch (verb) {
        case "status": return status();
        case "devices": return devices();
        case "pair":
          return asPerson("relay.pair.start", {}, d => {
            if (colour) { out(""); for (const l of terminal(qr(d.url))) out(l); out(""); out("  Scan this with your phone's camera. It works once, for 10 minutes."); }
            else out("  Open this address on your phone (the QR code shows in a colour terminal). It works once, for 10 minutes.");
            out(dim(`  ${d.url}`));
            if (!d.connected) out(dim("  the box is not at the relay yet; the code works as soon as it is (vyre relay)"));
            out(dim(`  ${OFFER_NOTE}`));
          }, d => ({ kind: "qr", text: String(d.url), caption: `Scan this with your phone's camera. It works once, for 10 minutes.${d.connected ? "" : " The box is not at the relay yet; it works as soon as it is."}` }));
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
