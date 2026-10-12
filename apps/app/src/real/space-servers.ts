// Which paired server hosts which Space, for a device paired to more than one (the phone, the browser, Windows): the map is built from what each server says it hosts (its own spaces.list), and the call that
// asks (src/real/box.ts tool) routes by it (server-route.js). With one pairing there is nothing to route, so the map is empty and every call goes where it always went. A server that did not answer keeps what
// was known of it, so one server being offline never loses the other's Spaces.
import { mergeSpaceLists, serverFor, spaceServersFrom } from "./server-route.js";

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

/** The servers that did not answer the last time they were asked (box ids): the switcher says "Offline" for them and keeps the rest. */
let offline: string[] = [];
export const offlineServers = (): string[] => offline;

/** Ask every paired server what it hosts and rebuild the map. Safe to call often; one pairing means no map. Returns what each server answered. */
async function askAll(): Promise<Record<string, Rows>> {
  const ids = await pairedBoxes();
  if (ids.length < 2) { map = {}; known = {}; offline = []; return {}; }
  const { peerCall } = await import("./peer");
  const got = await Promise.allSettled(ids.map((id) => peerCall<Rows>("spaces.list", {}, id)));
  const next: Record<string, Rows> = {};
  const down: string[] = [];
  ids.forEach((id, n) => { const r = got[n]; if (r.status === "fulfilled" && Array.isArray(r.value)) next[id] = r.value; else { down.push(id); next[id] = known[id] ?? []; } });
  known = next;
  offline = down;
  map = spaceServersFrom(known);
  if (down.length === ids.length) { const first = got.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined; throw first?.reason ?? new Error("No server answered."); }
  return known;
}

export async function refreshSpaceServers(): Promise<Record<string, string>> { await askAll().catch(() => {}); return map; }

/** The Spaces of every paired server, each row tagged with its server; null when the device has fewer than two servers (the caller then asks its one server as it always did). A server that is down keeps its last known rows. */
export async function listAllSpaces(): Promise<Array<Record<string, any>> | null> {
  if ((await pairedBoxes()).length < 2) return null;
  return mergeSpaceLists(await askAll());
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
