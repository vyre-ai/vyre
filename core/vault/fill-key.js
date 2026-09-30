// @ts-check
// fill-key: the fill listener's route for an API key a page showed, one tap in the extension.
//
//   POST /v1/fill/save-key { url, raisedOn, value, label?, generic? }
//        -> { name, kind, provider?, created, connected? }
//   POST /v1/fill/save-key { url, undo: <name> }
//        -> { name, removed: true }
//
// It needs a paired device and a live session, exactly what /v1/fill/save needs (gate), and only
// the extension's own origin gets this far (the listener's CORS check). The key is stored ready
// to use: an item with the kind and provider detect.js reads from the value's own shape, a name
// from the page's host and label, the page's origin recorded, and, when the provider is in the
// catalog, its details.provider so it shows up as a connection; a `connect` hook (given to Fill)
// may then grant it to a module whose need names that provider. There is no draft.
//
// The box decides, not the page: detect.js classifies the value again and anything that is not a
// secret is refused. The page origin must equal the origin the chip was raised on (the worker
// records that; a tab that moved on cannot save what the last page showed). Undo removes only an
// item this route made for this device, within two minutes. No value is ever returned, audited or
// put in an event.

import { classify } from "./detect.js";
import { gate, openFailed } from "./fill-save.js";
import { provider as catalog } from "./providers.js";

/**
 * The only sites a provider-shaped key may be saved AS that provider from (reviewer-2 H-K1): any web
 * page can print a string shaped like a key, and one trusted click would otherwise make the page's
 * own key the person's Anthropic, Slack or GitHub connection. From any other site the key is kept
 * as a plain key, never connected. An entry names the exact host, and a path prefix where the host also serves user content.
 */
export const PROVIDER_SITES = Object.freeze({
  anthropic: ["console.anthropic.com", "platform.claude.com"], "claude-setup-token": ["console.anthropic.com", "platform.claude.com"], openai: ["platform.openai.com"],
  github: ["github.com/settings"], slack: ["api.slack.com"], cloudflare: ["dash.cloudflare.com"], tailscale: ["login.tailscale.com"],
  deepgram: ["console.deepgram.com"], elevenlabs: ["elevenlabs.io/app"],
});
/** An entry is a host, or host/path-prefix: the key-issuing pages only, not the whole domain (a site's user content can print a key). @param {string} prov @param {string} host @param {string} [pathname] */
export const onProviderSite = (prov, host, pathname = "/") => (PROVIDER_SITES[/** @type {keyof typeof PROVIDER_SITES} */ (prov)] || []).some(e => {
  const [h, ...rest] = e.split("/");
  const prefix = rest.length ? "/" + rest.join("/") : "";
  return host === h && (!prefix || pathname === prefix || pathname.startsWith(prefix + "/"));
});

const MAX_VALUE = 8192;
/** Shapes that are never a key to keep, whatever detect.js makes of their randomness: ids and hashes. */
const NEVER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-f]{32}$|^[0-9a-f]{40}$|^[0-9a-f]{56}$|^[0-9a-f]{64}$|^[0-9a-f]{128}$/i;
const UNDO_MS = 2 * 60_000;

const fail = (status, code, message) => ({ status, body: { error: { code, message } } });
const ok = data => ({ status: 200, body: { data } });

function origin(u) {
  try { const x = new URL(String(u)); return ["http:", "https:"].includes(x.protocol) ? x.origin : null; } catch { return null; }
}

/** detect.js's type to the vault kind that holds it and the field that kind takes. */
const HOLD = {
  "api-key": ["api-key", "value"], pat: ["pat", "token"], oauth: ["oauth", "token"], cloud: ["cloud", "value"],
  secret: ["secret", "value"], webhook: ["secret", "value"],
};

/** "New key" to "new-key": what a label adds to an item's name. @param {unknown} s */
const slug = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);

/** @param {import("./vault.js").Vault} vault @param {string} base */
function freeName(vault, base) {
  const b = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 100) || "key";
  if (!vault.row(b)) return b;
  for (let i = 2; i < 1000; i++) if (!vault.row(`${b}-${i}`)) return `${b}-${i}`;
  throw new Error("too many keys for this host");
}

/**
 * @param {import("./fill.js").Fill} fill @param {any} b @param {Record<string, string>} h
 * @returns {Promise<{ status: number, body: any }>}
 */
export async function saveKeyRoute(fill, b, h) {
  const g = gate(fill, h, "fill-save-key", null);
  if (g.reply) return g.reply;
  const { d, who, refuse } = /** @type {any} */ (g);
  const vault = fill.vault;
  const o = origin(b.url);
  /** The page's path, for the key-issuing check. @param {any} u */
  const pagePath = u => { try { return new URL(String(u)).pathname; } catch { return "/"; } };
  if (!o) return refuse(400, "bad_input", "the page is not an http or https page");
  /** @type {Map<string, { id: string, device: string, at: number, origin: string }>} */
  const made = /** @type {any} */ (fill).savedKeys || (/** @type {any} */ (fill).savedKeys = new Map());

  if (b.undo !== undefined) {
    const name = typeof b.undo === "string" ? b.undo : "";
    const m = made.get(name);
    const r = m ? vault.row(name) : null;
    if (!m || !r || r.id !== m.id || m.device !== d.id || m.origin !== o || fill.now() - m.at > UNDO_MS) return refuse(404, "not_found", "nothing to undo");
    made.delete(name);
    try { vault.remove({ name }, who); } catch { return refuse(500, "internal", "could not undo the save"); }
    vault.audit("fill-save-key", name, who, true, `${o} undone`);
    return ok({ name, removed: true });
  }

  // The chip was raised on one page; the save must come from that same page.
  const raised = origin(b.raisedOn);
  if (!raised || raised !== o) return refuse(403, "wrong_origin", `the key was shown on ${raised || "another page"}, not ${o}`);
  if (typeof b.value !== "string" || b.value.length < 8 || b.value.length > MAX_VALUE) return refuse(400, "bad_input", "give the key to save");
  const value = b.value.trim();
  const label = typeof b.label === "string" ? b.label.slice(0, 60) : "";

  const c = classify("", value);
  const hold = c.secret && !c.public && !NEVER.test(value) ? HOLD[/** @type {keyof typeof HOLD} */ (c.type)] : null;
  if (!hold) return refuse(422, "not_a_key", "that does not look like a key to keep");
  const [kind, field] = hold;

  // The same key saved from the same site is one item.
  try {
    for (const row of /** @type {any[]} */ (fill.db.prepare("SELECT * FROM vault_items WHERE origin = ? AND kind != 'login'").all(o))) {
      if (!vault.rowOk("vault_items", row)) continue;
      const f = await vault.fields(row);
      if (Object.values(f).includes(value)) {
        vault.audit("fill-save-key", row.name, who, true, `${o} unchanged`);
        return ok({ name: row.name, kind: row.kind, created: false });
      }
    }
  } catch (e) { const [st, code, msg] = openFailed(e, o); return refuse(st, code, msg); }

  try {
    const host = new URL(o).hostname;
    const name = freeName(vault, `${host}-${slug(label) || "key"}`);
    const prov = c.provider && /^[a-z0-9][a-z0-9.-]{0,39}$/.test(c.provider) && onProviderSite(c.provider, host.toLowerCase(), pagePath(b.url)) ? c.provider : undefined;
    await vault.put({ name, kind, description: `${label || "key"} from ${o}`.slice(0, 200), fields: { [field]: value }, origin: o,
      ...(prov ? { details: { provider: prov } } : {}) }, who);
    const row = vault.row(name);
    made.set(name, { id: row.id, device: d.id, at: fill.now(), origin: o });
    /** @type {string|null} */
    let connected = null;
    const hook = /** @type {any} */ (fill).connect;
    if (prov && catalog(prov) && typeof hook === "function") {
      try { const r = await hook({ item: name, kind, provider: prov }); if (r && typeof r.module === "string") connected = r.module; } catch { /* the item is saved; a need stays open */ }
    }
    vault.audit("fill-save-key", name, who, true, `${o} created${prov ? ` ${prov}` : ""}`);
    vault.emit("vault.key-saved", { name, kind, ...(prov ? { provider: prov } : {}) });
    return ok({ name, kind, ...(prov ? { provider: prov } : {}), created: true, ...(connected ? { connected } : {}) });
  } catch (e) {
    const [st, code, msg] = openFailed(e, o);
    return refuse(st, code, st === 500 ? "could not save the key" : msg);
  }
}
