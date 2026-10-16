// @ts-check
// The invite link the owner shares, https://vyre.run/i/<token>, names no server. This is the one place that turns it into the link the join reads, https://<space>.vyre.run/join/<token>: the daemon's join
// (core/spaces) and the page host's join (apps/app/src/host) both call it, each with its own way to ask which space has a chain id. The link and the token are untrusted input: whatever name comes out only
// decides where the join looks, and the join then checks the space's chain against the pin the token carries (and a signed token against the space's pinned root key), so a wrong name is refused there.
import { inviteChainId, parseInvite } from "./first-run-shape.js";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/** @param {string} s base64url */
function fromB64u(s) {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  return new TextDecoder().decode(Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0)));
}

/**
 * What a join token says about its space. A token the space's root key signed carries the space's name (`space`); a kernel token (`inv_<32 hex>.<pin>`) carries the chain id of the space's list in its pin.
 * @param {string} token @returns {{ name: string } | { chain: string } | null}
 */
export function inviteSpaceHint(token) {
  const chain = inviteChainId(token);
  if (chain) return { chain };
  const parts = String(token || "").split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0])) return null;
  try {
    const p = JSON.parse(fromB64u(parts[0]));
    const name = p && typeof p.space === "string" ? p.space.toLowerCase().replace(/\.vyre\.run$/, "") : "";
    return LABEL.test(name) ? { name } : null;
  } catch { return null; }
}

/**
 * The join link for any invite link: a `<space>.vyre.run/join/<token>` link is returned as it is, and a `vyre.run/i/<token>` link becomes one for the space its token names.
 * @param {string} text
 * @param {{ lookupSpace: (chain: string) => Promise<{ kind?: string, id?: string, name?: string } | null | undefined> }} o which space has this chain id (the names directory, or a space this device already holds)
 * @returns {Promise<string>}
 */
export async function resolveInviteLink(text, o) {
  const p = parseInvite(text);
  if (!p) throw refuse("That link does not open a space. Ask for a new invite.", "bad_input");
  if (p.legacy) return p.link;
  const hint = inviteSpaceHint(p.token);
  if (!hint) throw refuse("This invite does not say which space it is for. Ask for a new one.", "bad_input");
  let name = "name" in hint ? hint.name : "";
  if (!name) {
    const chain = /** @type {{ chain: string }} */ (hint).chain;
    /** @type {any} */ let d = null;
    try { d = await o.lookupSpace(chain); } catch (e) { if (!e || /** @type {any} */ (e).code !== "not_found") throw refuse("Cannot reach the names directory right now.", "unreachable"); }
    name = d && d.kind === "space" && d.id === chain && typeof d.name === "string" ? d.name.toLowerCase().replace(/\.vyre\.run$/, "") : "";
    if (!LABEL.test(name)) throw refuse("That invite could not be matched to a space. Ask for a new one.", "not_found");
  }
  return `https://${name}.vyre.run/join/${p.token}`;
}

/** The link an owner shares for a join token: no server named, so a joiner never needs to know what a server is. @param {string} token */
export const publicInviteLink = (token) => `https://vyre.run/i/${token}`;

/**
 * The daemon's side of the same resolution (core/spaces parseLink): a link on any host but vyre.run goes through as it is, and a `vyre.run/i/<token>` link is resolved with the space this device already holds when
 * the token's chain id is one of them, else the names directory. Errors carry `refuse`'s shape.
 * @param {string} link
 * @param {{ spaces: { all(): any[] }, chainOf: (spaceId: string) => any, dir: { spaceByChain(id: string): Promise<any> }, refuse: (message: string, code: string) => Error }} d
 */
export async function daemonJoinLink(link, d) {
  let host = "";
  try { host = new URL(String(link)).hostname.toLowerCase(); } catch { return link; }
  if (host !== "vyre.run") return link;
  try {
    return await resolveInviteLink(String(link), {
      lookupSpace: async (chain) => {
        for (const r of d.spaces.all()) { const c = d.chainOf(r.id); if (c && c.pin && c.pin.id === chain) return { kind: "space", id: chain, name: String(r.name).replace(/\.vyre\.run$/, "") }; }
        return d.dir.spaceByChain(chain);
      },
    });
  } catch (e) { throw d.refuse(String(/** @type {any} */ (e).message || "That is not a valid invite."), String(/** @type {any} */ (e).code || "bad_input")); }
}
