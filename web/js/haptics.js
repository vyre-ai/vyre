// @ts-check
// Haptics on the phone (team/0.2.2/ux-research.md section 7, Haptics): system patterns only, each for what
// it means, and nothing on scroll. A tick for a tap that moves you (a tab, the nod), a success for an
// approval, a warning for a refusal.
//
// Where a phone can do it:
//   Android (Chrome, installed or not): navigator.vibrate with a short pattern.
//   iOS Safari 18 and later: no vibrate API, but toggling a native `<input type="checkbox" switch>`
//     plays the system's selection haptic, so a hidden one is clicked.
//   Anywhere else (iOS before 18, a laptop): nothing, silently. Never an error, never a sound.
// A person can turn it off: localStorage "vyre.haptics" = "off". Reduced motion does not change it
// (a haptic is not motion), but a hidden page or a tap-less call (no user gesture) is skipped.

/** @typedef {"tick" | "success" | "warning"} Kind */
/** The Android patterns, in ms: short and distinct, never buzzy. */
export const PATTERNS = Object.freeze({ tick: [8], success: [10, 40, 14], warning: [30, 50, 30] });

/** @type {HTMLLabelElement | null} */
let iosSwitch = null;

/**
 * @param {Kind} kind
 * @param {{ navigator?: any, document?: any, store?: any }} [env] seams for the tests
 * @returns {"vibrate" | "switch" | "none"} what was used
 */
export function haptic(kind, env = {}) {
  const nav = env.navigator ?? globalThis.navigator;
  const doc = env.document ?? globalThis.document;
  try {
    const store = env.store ?? globalThis.localStorage;
    if (store?.getItem("vyre.haptics") === "off") return "none";
  } catch {}
  if (!PATTERNS[kind] || (doc && doc.visibilityState === "hidden")) return "none";
  if (nav && typeof nav.vibrate === "function") {
    try { return nav.vibrate(PATTERNS[kind]) ? "vibrate" : "none"; } catch { return "none"; }
  }
  // iOS 18 Safari: the system plays its haptic when a switch checkbox changes through a real click.
  if (doc && typeof doc.createElement === "function" && /iPhone|iPad/.test(String(nav?.userAgent || ""))) {
    try {
      if (!iosSwitch || !iosSwitch.isConnected) {
        const label = doc.createElement("label");
        const input = doc.createElement("input");
        input.type = "checkbox";
        input.setAttribute("switch", "");
        input.tabIndex = -1;
        label.setAttribute("aria-hidden", "true");
        label.style.cssText = "position:fixed;left:-100px;top:-100px;width:1px;height:1px;opacity:0;pointer-events:none";
        label.append(input);
        doc.body.append(label);
        iosSwitch = label;
      }
      iosSwitch.click();
      return "switch";
    } catch { return "none"; }
  }
  return "none";
}
