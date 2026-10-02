// @ts-check
// pairing: the installed app's first launch, inside the app (app.vyre.run): the camera opens right here and reads a Vyre ring with
// the same scanner and the same screen as wink.vyre.run (relay/wink/page.js), never by navigating to wink.vyre.run, which on an
// iPhone leaves the installed app for a browser sheet. The screen does NO lookup and shows NO card: it hands the decoded ticket back,
// and loader.js runs the one path every ticket takes (one lookup, its own confirm card, then the pairing from the record it holds).
// loader.js imports this file only when it has to scan; release.js writes the paths of the shipped scanner files below.

/**
 * @param {{ relay: string, crypto: any, nav?: any, startScan?: any }} o  nav, startScan: fakes, for the tests
 * @returns {Promise<Uint8Array>} the decoded ticket (nothing has been looked up or redeemed)
 */
export async function scanTicket(o) {
  const { mountWink } = await import("../../wink/page.js");
  const startScan = o.startScan || (await import("../../../deck/js/scan.js")).startScan;
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
        startScan, haptic: k => haptic(k),
        navigate: () => {}, // never used: with onTicket the ticket goes back to the loader, not into a URL
        onTicket: t => resolve(t),
      });
      void reject;
    });
  } finally {
    page?.stop();
    host.remove();
    if (shell) shell.hidden = false;
  }
}
