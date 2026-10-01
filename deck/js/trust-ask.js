// @ts-check
// A browser paired from the hosted web app asking to be trusted with the owner's full powers (pairing devices,
// vault secrets): tailnet's `device.trust-asked {id, name, fingerprint}`, answered by `relay.devices.trust {id,
// trusted: true}` with the person's own presence (the existing tool; nothing here grants anything by itself).
// The prompt puts the KEY FINGERPRINT first, in mono, to compare with what that browser shows, and labels the name
// "says it is": the name is that browser's own claim, plain text, at most 64 characters. A toast points here, and
// the same card sits at the top of Settings, Your devices until it is answered or set aside (on this screen only).

import { h, put, go } from "./dom.js";
import { attempt, on } from "./api.js";
import { showToast } from "./toast.js";

/** The asks not yet answered, by device id. @type {Map<string, { id: string, name: string, fingerprint: string }>} */
const pending = new Map();
/** @type {Set<() => void>} */ const watchers = new Set();
const tell = () => { for (const fn of [...watchers]) fn(); };

/** A fingerprint in groups of four so it can be read out and compared. @param {string} fp */
export const grouped = fp => String(fp || "").replace(/\s+/g, "").replace(/(.{4})(?=.)/g, "$1 ");
/** The browser's own claim as text: no more than 64 characters, no control characters. @param {any} name */
export const claimed = name => String(name ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 64);

/** @param {any} p the event's payload @returns {{ id: string, name: string, fingerprint: string } | null} */
export function askOf(p) {
  if (!p || typeof p.id !== "string" || !p.id || typeof p.fingerprint !== "string" || !p.fingerprint) return null;
  return { id: p.id, name: claimed(p.name), fingerprint: String(p.fingerprint) };
}

/** Listen for asks for the whole session; call once. Returns the unsubscribe. */
export function installTrustAsk() {
  return on("device.trust-asked", e => {
    const a = askOf(e.payload);
    if (!a || pending.has(a.id)) return;
    pending.set(a.id, a);
    tell();
    showToast({ text: "A browser is asking for full access", action: { label: "Review", run: () => go("/settings#devices") }, ms: 12_000 });
  });
}

/** The cards for every open ask, redrawn when one arrives or is answered. @param {(el: HTMLElement | null) => void} into @returns {() => void} stop */
export function watchTrustAsks(into) {
  const draw = () => into(pending.size ? h("div", { class: "trust-asks" }, [...pending.values()].map(trustCard)) : null);
  watchers.add(draw);
  draw();
  return () => { watchers.delete(draw); };
}

/** @param {{ id: string, name: string, fingerprint: string }} a */
export function trustCard(a) {
  const status = h("p", { class: "small muted", role: "status" });
  const trust = /** @type {HTMLButtonElement} */ (h("button", { class: "btn btn-primary btn-sm", type: "button", "data-act": "trust", onclick: async () => {
    trust.disabled = true; put(status, "Waiting for you to confirm…");
    const r = await attempt("relay.devices.trust", { id: a.id, trusted: true }, { presence: "asked" });
    if (r.error) { trust.disabled = false; put(status, r.error.code === "cancelled" ? "Not trusted." : "That did not go through."); return; }
    pending.delete(a.id); tell();
  } }, "Trust this browser"));
  return h("section", { class: "set-row trust-card", "data-ask": a.id },
    h("div", { class: "set-k" }, "A browser wants full access"),
    h("div", { class: "set-v tm-col" },
      h("p", { class: "small" }, "Its key. Compare it with the one that browser shows:"),
      h("p", { class: "code trust-fp", "data-fp": "1" }, grouped(a.fingerprint)),
      h("p", { class: "small muted" }, "It says it is ", h("span", { class: "trust-name", "data-says": "1" }, a.name ? `"${a.name}"` : "(no name)"), ". That name is the browser's own claim, not something Vyre checked."),
      h("p", { class: "small muted" }, "Trusting it lets that browser pair devices and use vault secrets. Only trust a browser whose key matches."),
      h("div", { class: "tm-actions" }, trust,
        h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "later", onclick: () => { pending.delete(a.id); tell(); } }, "Not now")),
      status));
}
