// Which paired server hosts which Space, for a device paired to more than one (the phone, the browser, Windows): the map is built from what each server says it hosts (its own spaces.list), and the call that
// asks (src/real/box.ts tool) routes by it (server-route.js). With one pairing there is nothing to route, so the map is empty and every call goes where it always went. A server that did not answer keeps what
// was known of it, so one server being offline never loses the other's Spaces.
import { serverFor, spaceServersFrom } from "./server-route.js";

type Rows = Array<{ id?: unknown; member?: unknown } | null>;

let map: Record<string, string> = {};
let known: Record<string, Rows> = {};
let boxes: string[] | null = null;
let watching = false;

async function pairedBoxes(): Promise<string[]> {
  const { listPairings, subscribePairings } = await import("../api/relay");
  if (!watching) { watching = true; subscribePairings(() => { boxes = null; }); }
  return (boxes ??= (await listPairings()).map((p) => p.box));
}

/** Ask every paired server what it hosts and rebuild the map. Safe to call often; one pairing means no map. */
export async function refreshSpaceServers(): Promise<Record<string, string>> {
  const ids = await pairedBoxes();
  if (ids.length < 2) { map = {}; known = {}; return map; }
  const { peerCall } = await import("./peer");
  const got = await Promise.allSettled(ids.map((id) => peerCall<Rows>("spaces.list", {}, id)));
  const next: Record<string, Rows> = {};
  ids.forEach((id, n) => { const r = got[n]; next[id] = r.status === "fulfilled" && Array.isArray(r.value) ? r.value : known[id] ?? []; });
  known = next;
  map = spaceServersFrom(known);
  return map;
}

/** Which server a call goes to. `server` is a box id when the call names one. Throws nothing: an error comes back to the caller to refuse in words. */
export async function routeCall(o: { input: Record<string, unknown>; showing: string; server?: string }) {
  const paired = await pairedBoxes();
  if (paired.length < 2 && !o.server) return { box: undefined };
  if (paired.length >= 2 && !Object.keys(map).length) await refreshSpaceServers().catch(() => {});
  return serverFor({ explicit: o.server, input: o.input, showing: o.showing, spaceServers: map, paired });
}

/** The server that hosts a Space, as far as it is known (box id), or null. */
export const serverOfSpace = (space: string): string | null => map[space] ?? null;
