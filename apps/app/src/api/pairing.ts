// A stored pairing with a box through the relay (ADR 0026): the pure pieces, runnable in Node.
// The old offer link (`https://vyre.run/pair#...`) is gone; src/api/wink-code.ts refuses it.

/** What relay/client pair() returns: store it (it holds no secret) and hand it to createPaths. */
export type Pairing = {
  relay: string;
  route: string;
  box: string;
  name: string;
  device: string | null;
  presence: { enrolled: boolean; reason?: string } | null;
};

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
