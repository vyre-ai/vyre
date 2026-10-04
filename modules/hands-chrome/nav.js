// @ts-check
// Where a model may point the agent's Chrome (group D, the chrome.open question): public addresses only, the decision the runner's egress proxy makes (lib/netguard.js). Loopback, the daemon's ports,
// LAN and private ranges, link-local and the cloud metadata address, the box's own addresses, tailnet addresses and a name that resolves to any of them are refused for a model. The person's own
// call is not held to it (they may open a local page themselves), and the page a model is on is checked again after it loads, so a redirect into the box lands on about:blank and is refused.
import { resolvePublic } from "../../lib/netguard.js";

/**
 * Throw unless this URL's host is public. @param {string} url @param {{ lookup?: (h: string) => Promise<{ address: string }[]>, own?: string[] }} [o]
 */
export async function requirePublicUrl(url, o = {}) {
  let host;
  try { host = new URL(url).hostname; } catch { throw Object.assign(new Error(`"${url}" is not a URL`), { code: "bad_input" }); }
  if (!/^https?:$/.test(new URL(url).protocol)) throw Object.assign(new Error(`"${url}" is not an http(s) URL`), { code: "bad_input" });
  try { await resolvePublic(host, o); } catch (e) {
    const code = /** @type {any} */ (e).code;
    if (code === "NOT_PUBLIC" || code === "ENOTFOUND") throw Object.assign(new Error(`${host} is not a public address: an agent's Chrome reaches the public web only; take over in Glass to open a local page`), { code: "denied" });
    throw e;
  }
}
