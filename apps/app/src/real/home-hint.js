// @ts-check
// The home hint: the one route and pinned box key of the server that holds the person's personal vault. A brand-new device needs it before it can read the list in the vault (the names worker maps a TEAM Space's
// name to its servers, not a person's name to their vault's home). It rides beside the Secret Key in the GitHub escrow bundle, on the recovery kit, and from the approving device on the approve path. It is not secret
// (a route and a public key), and it is pinned: the connection checks the server holds `box` before any hello is sent. Pure.

export const HINT_MAX = 512;
const MIN_BOX = 32;

/** @typedef {{ v: 1, relay: string, route: string, box: string, name?: string, chainHello?: 1 }} HomeHint */

/** `chainHello: 1` says the server admits a device the identity chain lists (relay.status reports it); the app offers chain sign-in only to a server whose hint says so. @param {{ relay?: string, route?: string, box?: string, name?: string, chainHello?: number }} p @returns {HomeHint | null} */
export function homeHintOf(p) {
  if (!p || typeof p.relay !== "string" || typeof p.route !== "string" || typeof p.box !== "string" || p.box.length < MIN_BOX || !p.route) return null;
  const name = typeof p.name === "string" ? p.name.trim().slice(0, 64) : "";
  return { v: 1, relay: p.relay, route: p.route, box: p.box, ...(name ? { name } : {}), ...(p.chainHello === 1 ? { chainHello: /** @type {1} */ (1) } : {}) };
}

/** @param {HomeHint} h @returns {string} */
export function serializeHomeHint(h) {
  const text = JSON.stringify(h);
  if (text.length > HINT_MAX) throw Object.assign(new Error("The home hint is too long."), { code: "hint_too_big" });
  return text;
}

/** @param {string | null | undefined} text @returns {HomeHint | null} */
export function parseHomeHint(text) {
  let j;
  try { j = JSON.parse(String(text ?? "")); } catch { return null; }
  if (!j || j.v !== 1 || typeof j.relay !== "string" || !/^wss:\/\//.test(j.relay)) return null;
  return homeHintOf(j);
}

/** Does the server this hint names admit chain devices? An old server's hint has no flag, so the app offers it no chain sign-in. @param {HomeHint | null} h */
export const offersChainSignIn = (h) => Boolean(h && h.chainHello === 1);

const HINT_KEY = "vyre.home-hint";

/**
 * The device's one stored home hint, over a keyed text store. `store` takes the object or its JSON text and keeps it only if it is a pinned route; `load` gives it back or null. The first vault read on a device
 * with no pairing asks the hint's server (the pinned box). @param {{ get(k: string): Promise<string | null>, set(k: string, v: string): Promise<void>, del(k: string): Promise<void> }} kv
 */
export function makeHintStore(kv) {
  return {
    /** @param {unknown} hint @returns {Promise<boolean>} */
    async store(hint) {
      const h = parseHomeHint(typeof hint === "string" ? hint : JSON.stringify(hint ?? null));
      if (!h) return false;
      try { await kv.set(HINT_KEY, serializeHomeHint(h)); return true; } catch { return false; }
    },
    /** @returns {Promise<HomeHint | null>} */
    async load() { try { return parseHomeHint(await kv.get(HINT_KEY)); } catch { return null; } },
  };
}
