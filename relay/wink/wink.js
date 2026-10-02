// @ts-check
// The camera page at wink.vyre.run: a hosted static page like app.vyre.run (signed manifest, SRI, a service worker that
// installs only what the release key signed), with no account and no data. It opens the camera, reads a Vyre ring in the
// page, plays the lock haptic, shows "Opening Vyre" and hands the ticket to the hosted app (app.vyre.run/#pair=<ticket>), where
// the ticket is looked up ONCE, the app's own card is the only confirm, and the device key is made and the ticket redeemed
// (lead's one-card ruling and platform's wink-registry.md). It looks nothing up, makes no key, keeps no storage, sets no cookie
// and may connect nowhere. An iPhone or iPad in Safari gets the install steps instead: the installed app scans inside itself.
//
// The pieces: page.js (the screen), flow.js (the rules), the Deck's decoder and relay client (deck/js/scan.js,
// relay/client). Open: a QR or link carrying a purpose other than pairing (the registry's other purposes).

import { mountWink } from "./page.js";
import { startScan } from "../../deck/js/scan.js";
import { haptic } from "../../deck/js/haptics.js";

const root = /** @type {HTMLElement} */ (document.getElementById("wink-root"));
const wink = mountWink(root, {
  nav: navigator,
  standalone: (() => { try { return matchMedia("(display-mode: standalone)").matches; } catch { return false; } })(),
  // The worker that makes this page a signed one: installed once, and only when the release key signed it. page.js calls this only
  // when it is not the iPhone install page.
  registerWorker: () => { if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {}); },
  startScan,
  haptic: k => haptic(k),
  navigate: url => location.replace(url),
});
// Leaving the page (or hiding it) ends the camera: a live stream left open is exactly what "light by default" rules out.
addEventListener("pagehide", () => wink.stop());
