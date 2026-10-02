// @ts-check
// The camera page at wink.vyre.run: a hosted static page like app.vyre.run (signed manifest, SRI, a service worker
// that installs only what the release key signed), with no account and no data. It opens the camera, reads a
// Vyre code in the page, looks the ticket up through the relay WITHOUT pairing, shows who it pairs with, and only
// on the person's tap redeems it, then hands off to the person's own Vyre (the enrolment grant in the fragment,
// js/enroll-grant.js). It reuses the Deck's scan-to-pair sheet unchanged (deck/js/pair-scan.js), so the page and
// the Deck pair the same way. team/0.2.2/wink-registry.md section 5.
//
// What it does not do yet: more than one kind of code (the registry's purposes), and the iOS install hand-off
// (the enrolment grant's life against Add to Home Screen is an open point with tailnet and platform).

import { pairScanSheet } from "../../deck/js/pair-scan.js";
import { DEFAULT_RELAY } from "../../lib/relay-default.js";

const root = /** @type {HTMLElement} */ (document.getElementById("wink-root"));
// The worker that makes this page a signed one: installed once, and only when the release key signed it.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

const sheet = pairScanSheet({ relay: DEFAULT_RELAY, styles: false });
root.append(sheet.el);
// Leaving the page (or hiding it) ends the camera: a live stream left open is exactly what "light by default" rules out.
addEventListener("pagehide", () => sheet.close());
sheet.open();
