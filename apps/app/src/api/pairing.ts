// Pairing with a box through the relay (ADR 0026): the pure pieces, runnable in Node. The phone
// opens `vyre://pair?offer=<url-encoded offer>` (vyre phone add, or a scanned QR handed to the
// app); the web app opens `/app/pair?offer=...`. The offer is the box's own pairing URL,
// `https://vyre.run/pair#<base64url JSON>`, which relay/client pair() checks and uses.

/** Where every offer starts (relay/client/client.js PAIR_BASE). */
export const PAIR_BASE = "https://vyre.run/pair";

/** What relay/client pair() returns: store it (it holds no secret) and hand it to createPaths. */
export type Pairing = {
  relay: string;
  route: string;
  box: string;
  name: string;
  device: string | null;
  presence: { enrolled: boolean; reason?: string } | null;
};

const decode = (s: string): string | null => {
  try {
    return decodeURIComponent(s.replace(/\+/g, "%20"));
  } catch {
    return null;
  }
};

const isOffer = (s: string) => s.startsWith(PAIR_BASE + "#") && s.length > PAIR_BASE.length + 1;

/**
 * The offer URL in a pairing link, or null when there is none. Takes the whole link
 * (`vyre://pair?offer=...`, `https://<host>/app/pair?offer=...`) or the `offer` value alone,
 * encoded once or not at all. An offer whose `#` was not encoded arrives split between the
 * query and the fragment, and is joined again.
 */
export function offerFrom(link: string | null | undefined): string | null {
  if (!link) return null;
  const raw = String(link).trim();
  const bare = decode(raw);
  if (bare && isOffer(bare)) return bare;
  const q = raw.indexOf("?");
  if (q < 0) return null;
  const hashAt = raw.indexOf("#", q);
  const query = raw.slice(q + 1, hashAt < 0 ? undefined : hashAt);
  const fragment = hashAt < 0 ? "" : raw.slice(hashAt);
  for (const part of query.split("&")) {
    if (!part.startsWith("offer=")) continue;
    let v = decode(part.slice(6));
    if (!v) return null;
    if (v === PAIR_BASE && fragment) v += fragment;
    return isOffer(v) ? v : null;
  }
  return null;
}

/** A stored pairing, checked, or null. */
export function readPairing(json: string | null | undefined): Pairing | null {
  if (!json) return null;
  let v: Partial<Pairing> | null;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!v || typeof v.relay !== "string" || !/^wss?:\/\//.test(v.relay) || typeof v.route !== "string" || typeof v.box !== "string") return null;
  return {
    relay: v.relay,
    route: v.route,
    box: v.box,
    name: typeof v.name === "string" ? v.name : "",
    device: typeof v.device === "string" ? v.device : null,
    presence: v.presence && typeof v.presence === "object" ? v.presence : null,
  };
}

/**
 * The box's address over the relay, as an http(s) base: it names the box to the client (stores,
 * the stream's path label) and carries the route as a prefix the box never sees, so a request's
 * proof signs only the box's own path (person.ts boxPath).
 */
export function relayBase(p: Pick<Pairing, "relay" | "route">): string {
  return p.relay.replace(/^ws/, "http").replace(/\/+$/, "") + "/" + encodeURIComponent(p.route);
}
