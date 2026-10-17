// @ts-check
// Where a model may point the agent's Chrome (group D, the chrome.open question): public addresses only, the decision the runner's egress proxy makes (lib/netguard.js). Loopback, the daemon's ports,
// LAN and private ranges, link-local and the cloud metadata address, the box's own addresses, tailnet addresses and a name that resolves to any of them are refused for a model. The person's own
// call is not held to it (they may open a local page themselves), and the page a model is on is checked again after it loads, so a redirect into the box lands on about:blank and is refused.
import { guardAgentNavigate } from "../../lib/browser-access.js";

/**
 * Throw unless this URL's host is public. @param {string} url @param {{ lookup?: (h: string) => Promise<{ address: string }[]>, own?: string[] }} [o]
 */
export async function requirePublicUrl(url, o = {}) {
  await guardAgentNavigate(url, { guarded: true, ...o });
}
