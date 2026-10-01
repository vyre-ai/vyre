// @ts-check
// Face ID for this phone, offered once at pairing (lead's ruling, tailnet's contract in CHAT.md).
// Pairing on the hosted page (phone.vyre.run) hands the box's one-time enrolment grant to the
// person's own address in the URL fragment, https://<rpId>/#enroll=<grant>. The fragment never
// reaches a server or a log. Here it is read once, taken out of the address bar and history at
// once, and kept in memory only; a sheet then asks for the one Face ID prompt that makes this
// phone's passkey (js/phone-setup.js enrollPasskey, method grant). A passkey is asked for after
// that only for vault reveals and sends nobody asked for.

import { h } from "./dom.js";

const GRANT = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * The grant in a location hash, or null. Pure.
 * @param {string} hash
 */
export function grantFromHash(hash) {
  const m = /^#enroll=([^&]*)$/.exec(String(hash || ""));
  return m && GRANT.test(m[1]) ? m[1] : null;
}

/**
 * The fragment the pairing page redirects with: the box's own host and the grant. Refuses a
 * host that is not a plain hostname.
 * @param {{ grant: string, rpId: string }} enroll
 * @returns {string | null}
 */
export function enrollUrl(enroll) {
  if (!enroll || !GRANT.test(enroll.grant) || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(enroll.rpId)) return null;
  return `https://${enroll.rpId.toLowerCase()}/#enroll=${enroll.grant}`;
}

/**
 * Take the grant out of the address: read it, then remove it from the bar and the history entry.
 * @param {{ hash: string, pathname: string, search: string }} loc @param {{ replaceState: (s: any, t: string, u: string) => void, state?: any }} hist
 */
export function takeGrant(loc, hist) {
  const g = grantFromHash(loc.hash);
  if (loc.hash.startsWith("#enroll=")) { try { hist.replaceState(hist.state ?? null, "", loc.pathname + loc.search); } catch {} }
  return g;
}

/**
 * If this load came from pairing with a grant, offer the Face ID step in a sheet. `enroll` makes
 * the passkey ({ grant }) and resolves; it throws plain words, shown with Try again. Returns
 * whether a sheet was opened. (The sheet is loaded on demand: a load with no grant costs nothing.)
 * @returns {Promise<boolean>} @param {{ enroll: (a: { grant: string }) => Promise<any>, canProve: () => boolean, loc?: any, hist?: any }} d
 */
export async function offerEnroll(d) {
  const grant = takeGrant(d.loc || location, d.hist || history);
  if (!grant || !d.canProve()) return false;
  const { openSheet } = await import("./sheet.js");
  openSheet({ title: "Turn on Face ID", label: "Turn on Face ID", build(body, close) {
    const note = h("p", { class: "small muted", role: "status" });
    const go = h("button", { type: "button", class: "btn btn-primary" }, "Turn on Face ID");
    go.addEventListener("click", async () => {
      go.disabled = true; note.textContent = "";
      try { await d.enroll({ grant }); note.textContent = "Done. Face ID is on for this phone."; go.remove(); setTimeout(close, 900); }
      catch (e) { note.textContent = String(/** @type {any} */ (e)?.message || e); go.disabled = false; go.textContent = "Try again"; }
    });
    const later = h("button", { type: "button", class: "btn btn-ghost", onclick: close }, "Not now");
    body.append(
      h("p", null, "Face ID keeps your vault and anything you did not ask for behind you. It is asked only then, nothing else."),
      note, h("div", { class: "row" }, go, later));
  } });
  return true;
}
