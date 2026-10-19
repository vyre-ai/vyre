// @ts-check
// Opening a link outside the app, the one way. In the Mac app's window window.open and Linking.openURL do nothing (the page has no popups and no URL handler), so the shell's own "open" (NSWorkspace,
// VyreAppWindow.swift) is used when the page runs there; a browser opens a window; a phone hands the link to the system. Pure: what the page has is passed in, so it is tested without a screen.

/**
 * @typedef {{ shellOpen?: ((url: string) => Promise<unknown>) | null, windowOpen?: ((url: string, name: string, features: string) => { closed?: boolean, close?: () => void } | null) | null, linkingOpen?: ((url: string) => Promise<unknown>) | null }} OpenEnv
 * @typedef {{ opened: boolean, via: "shell" | "window" | "system" | "none", window: { closed?: boolean, close?: () => void } | null }} Opened
 */

/** Only links a person could mean: a web address, a mail or phone link. Anything else (javascript:, file:, data:) is never opened. @param {unknown} url */
export function openableUrl(url) {
  const s = String(url ?? "").trim();
  return /^(https?:\/\/[^\s]+|mailto:[^\s]+|tel:[^\s]+)$/i.test(s) ? s : null;
}

/**
 * Open a link: the shell's open for a web address when the page is in the Mac app, else a window (name and features for a sign-in popup), else the system's handler. `opened` is false when nothing
 * took it (a blocked popup, a refused link), so the caller can show the link to copy instead.
 * @param {string} url @param {{ name?: string, features?: string }} o @param {OpenEnv} env @returns {Promise<Opened>}
 */
export async function openExternalWith(url, o, env) {
  const u = openableUrl(url);
  if (!u) return { opened: false, via: "none", window: null };
  const web = /^https?:/i.test(u);
  if (web && env.shellOpen) {
    try { await env.shellOpen(u); return { opened: true, via: "shell", window: null }; } catch { /* fall through to a window */ }
  }
  // a mail or phone link goes to the system's handler; a web address to a window
  if (!web && env.linkingOpen) {
    try { await env.linkingOpen(u); return { opened: true, via: "system", window: null }; } catch { return { opened: false, via: "system", window: null }; }
  }
  if (env.windowOpen) {
    const features = o.features || "noopener,noreferrer";
    const w = env.windowOpen(u, o.name || "_blank", features);
    // a window opened with noopener is answered null by the browser whether it opened or not: that is not a blocked popup
    if (!w && /noopener/.test(features)) return { opened: true, via: "window", window: null };
    return w ? { opened: true, via: "window", window: w } : { opened: false, via: "window", window: null };
  }
  if (env.linkingOpen) {
    try { await env.linkingOpen(u); return { opened: true, via: "system", window: null }; } catch { return { opened: false, via: "system", window: null }; }
  }
  return { opened: false, via: "none", window: null };
}
