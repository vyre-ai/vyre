// @ts-check
// pairing: the hosted app's first pairing, inside the app (app.vyre.run), on the same screen as wink.vyre.run's camera page
// (relay/wink/page.js). Two ways in:
//   - a ticket handed over by the camera page in the address (`#pair=<ticket>`, read once and scrubbed from the address by loader.js):
//     this app looks the ticket up AGAIN and shows its OWN card before it redeems anything (the card the person saw on another origin
//     is not trusted here);
//   - no server yet (the installed app's first launch): the scanner opens right here, never by navigating to wink.vyre.run, which on
//     an iPhone leaves the installed app for a browser sheet.
// Either way, the ticket is redeemed only when the person taps Pair, by this origin's own device key (IndexedDB), and the screen is
// removed when it is done. The passkey is enrolled here afterwards, over the connection (enrol.js, once the box accepts this origin).
// loader.js imports this file only when it has to pair; release.js writes the paths of the shipped scanner files below.

import { pairTicket, resolveTicket } from "./client/client.js";

/**
 * @param {{ ticket?: Uint8Array | null, relay: string, name: string, about: any, keyStore: any, crypto: any, nav?: any,
 *   client?: { pairTicket: typeof pairTicket, resolveTicket: typeof resolveTicket } }} o  client: fakes, for the tests; the default is the shipped relay client
 * @returns {Promise<any>} the box record to store, once the person has confirmed and the pairing finished
 */
export async function pairInApp(o) {
  const client = o.client || { pairTicket, resolveTicket };
  const { mountWink } = await import("../../wink/page.js");
  const { startScan } = await import("../../../deck/js/scan.js");
  const { haptic } = await import("../../../deck/js/haptics.js");
  document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/relay/wink/wink.css" }));
  const host = document.createElement("div");
  host.id = "vyre-wink";
  document.body.append(host);
  const shell = document.getElementById("vyre-loader");
  if (shell) shell.hidden = true;
  /** @type {{ stop: () => void } | null} */ let page = null;
  try {
    return await new Promise((resolve, reject) => {
      page = mountWink(host, {
        nav: o.nav || navigator,
        standalone: (() => { try { return matchMedia("(display-mode: standalone)").matches; } catch { return false; } })(),
        relay: o.relay, crypto: o.crypto, startScan, resolveTicket: client.resolveTicket,
        sha256: async b => new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", b)),
        haptic: k => haptic(k),
        navigate: () => {}, // never used: with redeem the ticket goes to the pairing below, not into a URL
        ...(o.ticket ? { ticket: o.ticket } : {}),
        redeem: async ticket => {
          try { resolve(await client.pairTicket(ticket, { relay: o.relay, name: o.name, about: o.about, keyStore: o.keyStore, crypto: o.crypto })); }
          catch (e) { reject(e); }
        },
      });
    });
  } finally {
    page?.stop();
    host.remove();
    if (shell) shell.hidden = false;
  }
}
