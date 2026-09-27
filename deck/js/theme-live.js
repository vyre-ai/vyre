// @ts-check
// The live theme from the settings hub (docs/adr/0035-settings-hub.md, section 5): the Deck reads
// settings.snapshot once at start, links /theme.css for this device at the hub's rev, and follows
// settings.changed. A change to an appearance.* key swaps the stylesheet link to the new rev (the
// new sheet loads beside the old one, which goes only once the new one has loaded: no reload, no
// flash) and sets the scheme. A reconnect compares rev once and reads again if it moved. Nothing
// polls; while the page is hidden the stream is closed, and the comparison on its return catches
// what changed meanwhile.
//
// Feature-detected: a box without settings.snapshot (no hub yet) keeps today's /theme.css and the
// scheme chosen on this device (localStorage "vyre.theme"). The device is the hub's to resolve:
// the Deck names one only when the snapshot said which (`device`), never inventing an id.

/** The stylesheet address for a device and rev. @param {{ device?: string | null, rev?: number | null }} at */
export function themeHref({ device, rev } = {}) {
  const q = new URLSearchParams();
  if (device) q.set("device", device);
  if (rev != null) q.set("rev", String(rev));
  const s = q.toString();
  return "/theme.css" + (s ? "?" + s : "");
}

/** The data-theme for appearance.scheme: "paper", "dark", or "system" following the OS.
 * @param {unknown} scheme @param {boolean} prefersLight @returns {"paper" | "dark" | null} null: no hub value */
export function schemeFor(scheme, prefersLight) {
  if (scheme === "paper") return "paper";
  if (scheme === "dark") return "dark";
  if (scheme === "system") return prefersLight ? "paper" : "dark";
  return null;
}

/** Whether a settings.changed event means the theme is to be read again. @param {any} e */
export const repaints = e => typeof e?.payload?.key === "string" && e.payload.key.startsWith("appearance.");

/**
 * Follow the hub's theme. Returns stop().
 * @param {{
 *   attempt: (name: string, input?: Record<string, any>) => Promise<{ data?: any, error?: any }>,
 *   on: (type: string, fn: (e: any) => void) => () => void,
 *   onResume: (fn: (why: string) => void) => () => void,
 *   doc?: Document, media?: (q: string) => { matches: boolean, addEventListener?: Function, removeEventListener?: Function },
 * }} deps
 */
export function followTheme({ attempt, on, onResume, doc = document, media = q => matchMedia(q) }) {
  /** @type {{ rev: number | null, device: string | null, scheme: unknown }} */
  const at = { rev: null, device: null, scheme: undefined };
  let hub = true, stopped = false;
  const light = media("(prefers-color-scheme: light)");

  const scheme = () => {
    const v = schemeFor(at.scheme, !!light.matches);
    if (!v) return; // no hub value: this device's own choice stands
    if (v === "paper") doc.documentElement.dataset.theme = "paper"; else delete doc.documentElement.dataset.theme;
  };

  /** Swap the theme link to this rev; the old one leaves once the new one has loaded (or failed). */
  const link = () => {
    const href = themeHref(at);
    const old = /** @type {HTMLLinkElement[]} */ ([...doc.querySelectorAll('link[rel="stylesheet"][href^="/theme.css"]')]);
    if (old.some(l => l.getAttribute("href") === href)) return;
    const next = /** @type {HTMLLinkElement} */ (doc.createElement("link"));
    next.rel = "stylesheet";
    next.href = href;
    const done = () => { for (const l of old) l.remove(); };
    next.addEventListener("load", done, { once: true });
    next.addEventListener("error", done, { once: true });
    const last = old[old.length - 1];
    if (last) last.after(next); else doc.head.append(next);
  };

  const read = async () => {
    if (!hub || stopped) return;
    const r = await attempt("settings.snapshot", {});
    if (stopped) return;
    if (r.error) { if (r.error.code === "no_such_tool" || r.error.code === "unknown_tool") hub = false; return; }
    const d = r.data || {};
    const moved = d.rev !== at.rev || (d.device || null) !== at.device;
    at.rev = typeof d.rev === "number" ? d.rev : null;
    at.device = typeof d.device === "string" ? d.device : null;
    at.scheme = d.values?.["appearance.scheme"];
    scheme();
    if (moved) link();
  };

  const offChanged = on("settings.changed", e => {
    if (!repaints(e)) return;
    const p = e.payload;
    // Another device's change repaints nothing here.
    if (p.device && at.device && p.device !== at.device) return;
    void read();
  });
  const offResume = onResume(() => { void read(); });
  const onScheme = () => scheme();
  light.addEventListener?.("change", onScheme);
  void read();
  return () => { stopped = true; offChanged(); offResume(); light.removeEventListener?.("change", onScheme); };
}
