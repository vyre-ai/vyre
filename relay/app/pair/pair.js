// @ts-check
// pair: the page at vyre.run/pair that a Vyre QR code opens (ADR 0026 sections 6 and 10). It checks
// that the fragment is a Vyre pairing offer, then offers the app (vyre://pair#...) or the hosted
// web app (https://app.vyre.run/pair#...), both carrying the same fragment. It makes no request,
// and the fragment never leaves the device.

/**
 * The offer in a fragment, or null. The same format as core/relay/pairing.js.
 * @param {string} fragment without the leading #
 */
export function parseOffer(fragment) {
  let o;
  try {
    const b64 = String(fragment).replace(/-/g, "+").replace(/_/g, "/");
    o = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64 + "===".slice((b64.length + 3) % 4)), c => c.charCodeAt(0))));
  } catch { return null; }
  if (!o || o.v !== 1 || typeof o.r !== "string" || !/^wss?:\/\/[^\s/]+/.test(o.r) || !/^[a-z2-7]{26}$/.test(String(o.i)) || typeof o.s !== "string" || typeof o.k !== "string") return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(o.k)) return null;
  return { relay: o.r, route: o.i, name: typeof o.n === "string" ? o.n.slice(0, 64) : "" };
}

if (typeof document !== "undefined") {
  const fragment = location.hash.slice(1);
  const offer = parseOffer(fragment);
  const about = /** @type {HTMLElement} */ (document.getElementById("about"));
  if (!offer) about.textContent = "This is not a Vyre pairing code. Make a new one on your box: Settings, Devices, Add a device.";
  else {
    about.textContent = offer.name ? `This code pairs this device with ${offer.name}. It works once, for 10 minutes.` : "This code pairs this device with your box. It works once, for 10 minutes.";
    /** @type {HTMLAnchorElement} */ (document.getElementById("app")).href = `vyre://pair#${fragment}`;
    /** @type {HTMLAnchorElement} */ (document.getElementById("web")).href = `https://app.vyre.run/pair#${fragment}`;
    /** @type {HTMLElement} */ (document.getElementById("actions")).hidden = false;
  }
}
