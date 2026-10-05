// Devices and vault trust as data, no DOM and no React (the TrustBrowser, Vault and Devices
// boards). What the app decides from the box's relay.devices.list, this device's own relay id and
// kind, and the box's answers:
//   - whether this device may take a secret out of the vault (trusted, untrusted, unknown)
//   - which trust control each device row shows, and in which style
//   - the path, last seen and expiry lines
//   - the vault's rows (name, kind, site), never a value
// The box (core/relay/index.js) is the authority: an untrusted web device is refused
// (WEB_DENY) whatever this file says. This only puts the reason where the secret would be.

/** One row of relay.devices.list (core/relay/index.js view()). */
export type Device = {
  id: string;
  name: string;
  kind: string;
  pairedAt: number;
  lastSeen: number | null;
  presence?: boolean;
  online: boolean;
  path: "relay" | "direct" | null;
  rtt?: number | null;
  node?: string;
  /** Web devices only. */
  trusted?: boolean;
  release?: string | null;
  build?: "known" | "unknown";
  expiresAt?: number;
};

export type Trust = "trusted" | "untrusted" | "unknown";

export const DAY = 24 * 60 * 60_000;

/** A device list from the box's answer, dropping what is not a device. */
export function readDevices(data: unknown): Device[] {
  const list = (data as { devices?: unknown } | null)?.devices;
  if (!Array.isArray(list)) return [];
  return list.filter((d): d is Device => !!d && typeof d === "object" && typeof (d as Device).id === "string" && typeof (d as Device).name === "string");
}

/**
 * Whether this device may take a secret out of the vault.
 *   - the native app (kind "app") is trusted: the box never limits it
 *   - a browser with no relay device id is the box-served app (the box's own origin): trusted
 *   - a paired browser is what the box's list says about its id; not listed yet is unknown
 *   - `denied`: the box refused a secret to this browser, which settles it until the list says
 *     otherwise (a trust that lands later shows in the list, and wins)
 */
export function trustOf(o: { kind: "app" | "web"; self: string | null; devices: readonly Device[] | null; denied?: boolean }): Trust {
  if (o.kind !== "web" || !o.self) return "trusted";
  const me = o.devices?.find((d) => d.id === o.self);
  if (me && me.kind === "web") {
    if (me.trusted) return "trusted";
    return "untrusted";
  }
  if (me) return "trusted";
  return o.denied ? "untrusted" : "unknown";
}

/**
 * A denied answer when a secret was asked for. The box's WEB_DENY answers as vyred does for a
 * tool a caller may not reach (404 no_such_tool); "denied" is what a box that says so out loud
 * would send. Only a browser can be told either about vault.reveal or vault.copy.
 */
export function isDenied(kind: "app" | "web", error: { code?: string } | null | undefined): boolean {
  if (kind !== "web" || !error) return false;
  return error.code === "denied" || error.code === "no_such_tool";
}

export type Control = {
  /** What the button does: relay.devices.trust with this value. */
  trusted: boolean;
  label: string;
  style: "secondary" | "ghost" | "outline";
  /** The line under the button. */
  note: string;
};

export type RowChoice = {
  /** The pill beside the name. */
  badge: string | null;
  /** The warning line for a build this box does not ship. */
  warning: string | null;
  control: Control | null;
};

export const UNKNOWN_BUILD = "This browser runs a build Vyre doesn't recognise. Don't trust it unless you just updated.";

/** Where the app runs, for the proof it names: Platform.OS. */
export type Os = "ios" | "android" | "web" | (string & {});

/**
 * The note beside Trust names the proof this device asks for (the device-row spec's copy): Face ID
 * on an iPhone, fingerprint on Android, Touch ID on the web build (a Mac's browser, the Deck's words).
 */
export function proofNote(os: Os): string {
  if (os === "ios") return "Face ID follows";
  if (os === "android") return "Fingerprint follows";
  return "Touch ID follows";
}

/**
 * What a device row shows. Only browsers have trust. An untrusted browser gets no controls at all
 * (the box refuses relay.devices.trust from it), so `viewer` is this device's own trust.
 */
export function rowChoice(d: Device, viewer: Trust, os: Os = "web"): RowChoice {
  if (d.kind !== "web") return { badge: null, warning: null, control: null };
  const unknown = d.build === "unknown";
  const badge = unknown ? "Unknown build" : d.trusted ? "Trusted" : "Untrusted";
  const warning = unknown ? UNKNOWN_BUILD : null;
  if (viewer === "untrusted") return { badge, warning, control: null };
  if (d.trusted) return { badge, warning, control: { trusted: false, label: "Stop trusting", style: "ghost", note: "One tap" } };
  return { badge, warning, control: { trusted: true, label: "Trust this browser", style: unknown ? "outline" : "secondary", note: proofNote(os) } };
}

/** The powers line under a browser's name. */
export function powersText(d: Device): string | null {
  if (d.kind !== "web") return null;
  return d.trusted ? "Trusted · full powers of your app" : "Limited: no vault secrets, can't add devices";
}

/** How many days unused a browser lasts: the box's setting when given, else read from its expiresAt. */
export function expiryDays(d: Device, setting?: number | null): number | null {
  if (typeof setting === "number" && setting > 0) return Math.round(setting);
  if (d.kind !== "web" || typeof d.expiresAt !== "number") return null;
  const from = d.lastSeen ?? d.pairedAt;
  if (typeof from !== "number") return null;
  const days = Math.round((d.expiresAt - from) / DAY);
  return days > 0 ? days : null;
}

/** "Expires after 30 days unused", for browsers only. */
export function expiryText(d: Device, setting?: number | null): string | null {
  const n = expiryDays(d, setting);
  return n === null ? null : `Expires after ${n} ${n === 1 ? "day" : "days"} unused`;
}

/** "Browser", "App": what kind of device it is. */
export function kindText(d: Device): string {
  if (d.kind === "web") return "Browser";
  if (d.kind === "app") return "App";
  return d.kind ? d.kind[0].toUpperCase() + d.kind.slice(1) : "Device";
}

/** How it reaches the box right now: "Relay · 80 ms", "Direct · 12 ms", "Not connected". */
export function pathText(d: Device): string {
  const ms = typeof d.rtt === "number" ? ` ${Math.round(d.rtt)} ms` : "";
  if (d.path === "relay") return `Relay${ms ? " ·" + ms : ""}`;
  if (d.path === "direct") return `Direct${ms ? " ·" + ms : ""}`;
  return "Not connected";
}

/** "Seen now" while connected, else how long ago. */
export function seenText(d: Device, now: number): string {
  if (d.online) return "Seen now";
  const at = d.lastSeen ?? d.pairedAt;
  if (typeof at !== "number") return "Never seen";
  const m = Math.max(0, Math.floor((now - at) / 60_000));
  if (m < 1) return "Seen now";
  if (m < 60) return `Seen ${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Seen ${h} h ago`;
  const days = Math.floor(h / 24);
  return `Seen ${days} ${days === 1 ? "day" : "days"} ago`;
}

/** The "How" line on the vault card: where to trust this browser from. */
export function howText(name: string): string {
  return `On your Mac: Devices, ${name || "this browser"}, Trust`;
}

/** The stream came back after it was not open: the moment trust may have changed ("trust changed"). */
export function reopened(prev: string | null | undefined, next: string | null | undefined): boolean {
  return next === "open" && !!prev && prev !== "open";
}

// ---- the vault's rows ------------------------------------------------------------------------

/** One row of vault.list: names, kinds, sites, field names. Never a value. */
export type VaultItem = {
  name: string;
  kind: string;
  description?: string;
  fields?: string[];
  url?: string;
  hosts?: string[];
  vault?: string;
};

export function readVault(data: unknown): { locked: boolean; items: VaultItem[] } {
  const d = (data ?? {}) as { locked?: unknown; items?: unknown };
  const items = Array.isArray(d.items)
    ? d.items.filter((i): i is VaultItem => !!i && typeof i === "object" && typeof (i as VaultItem).name === "string")
    : [];
  return { locked: d.locked === true, items };
}

const KINDS: Record<string, string> = {
  login: "Login",
  passkey: "Passkey",
  totp: "Code",
  code: "Code",
  authenticator: "Code",
  "api-key": "API key",
  apikey: "API key",
  "ssh-key": "SSH key",
  card: "Card",
  note: "Note",
  env: ".env file",
  "env-file": ".env file",
  secret: "Secret",
};

export function kindLabel(kind: string): string {
  const k = String(kind || "").toLowerCase();
  return KINDS[k] ?? (k ? k[0].toUpperCase() + k.slice(1).replace(/-/g, " ") : "Secret");
}

/** The item's site as a host: its url's host, else its first host. */
export function siteOf(it: VaultItem): string | null {
  const raw = it.url || it.hosts?.[0];
  if (!raw) return null;
  try {
    return new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`).host || null;
  } catch {
    return raw;
  }
}

/** "Login · app.northwind.test", or the kind alone. */
export function vaultDetail(it: VaultItem): string {
  const site = siteOf(it);
  return site ? `${kindLabel(it.kind)} · ${site}` : kindLabel(it.kind);
}

/** The fields shown in the item, values hidden: the listed field names, or "value" when none. */
export function fieldsOf(it: VaultItem): string[] {
  const f = (it.fields ?? []).filter((x) => typeof x === "string" && x);
  return f.length ? f : ["value"];
}

export function fieldLabel(field: string): string {
  if (field === "totp") return "One-time code";
  return field ? field[0].toUpperCase() + field.slice(1).replace(/[_-]/g, " ") : "Value";
}

/** Dots for a hidden value, their count unrelated to its length. */
export const HIDDEN = "••••••••••";

/** The line under the vault list. */
export function vaultFooter(n: number): string {
  return `${n} ${n === 1 ? "item" : "items"} · names, kinds and sites sync here`;
}
