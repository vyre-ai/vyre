// Which paired server hosts which Space, for a device paired to more than one (the phone, the browser, Windows): the map is built from what each server says it hosts (its own spaces.list), and the call that
// asks (src/real/box.ts tool) routes by it (server-route.js). With one pairing there is nothing to route, so the map is empty and every call goes where it always went. A server that did not answer keeps what
// was known of it, so one server being offline never loses the other's Spaces.
import { approvalServersFrom, mergeAmbiguous, chatServersFrom, itemSpacesFrom, mergeSpaceLists, serverFor, spaceServersFrom } from "./server-route.js";

type Rows = Array<{ id?: unknown; member?: unknown } | null>;

let map: Record<string, string> = {};
let known: Record<string, Rows> = {};
let boxes: string[] | null = null;
/** Which server holds each chat, learned from every server's own chat list. */
let chatMap: Record<string, string> = {};
/** The Space each item id was seen in (from a list, or the call that made it), for actions that name an item by its id alone. */
let itemMap: Record<string, string> = {};
/** Which server holds each held act in the approvals inbox. */
let approvalMap: Record<string, string> = {};
let missed: string[] = [];
let watching = false;

/** What this file asks of the device: its pairings and one call to a named server. The app's own are loaded when none are set; a Node test sets fakes. */
export type Ports = { listPairings: () => Promise<Array<{ box: string }>>; subscribePairings: (cb: () => void) => () => void; peerCall: <T = unknown>(tool: string, input: Record<string, unknown>, box?: string) => Promise<T> };
let ports: Ports | null = null;
export function setPorts(p: Ports | null): void { ports = p; multi = false; primed = null; map = {}; known = {}; boxes = null; chatMap = {}; itemMap = {}; approvalMap = {}; missed = []; offline = []; watching = false; }
const io = async (): Promise<Ports> => ports ?? { ...(await import("../api/relay")), peerCall: (await import("./peer")).peerCall };

/** Is this device paired to more than one server? A flag a synchronous caller can read; primeServers() sets it before the first call. */
let multi = false;
export const multiServers = (): boolean => multi;
let primed: Promise<void> | null = null;
/** Read the pairings once (and again after every change) so multiServers() is true before the first call is made. */
export function primeServers(): Promise<void> { return (primed ??= pairedBoxes().then(() => undefined, () => undefined)); }

async function pairedBoxes(): Promise<string[]> {
  const { listPairings, subscribePairings } = await io();
  if (!watching) { watching = true; subscribePairings(() => { boxes = null; void pairedBoxes(); }); }
  const got = (boxes ??= (await listPairings()).map((p) => p.box));
  multi = got.length > 1;
  return got;
}

/** The servers that did not answer the last time they were asked (box ids): the switcher says "Offline" for them and keeps the rest. */
let offline: string[] = [];
export const offlineServers = (): string[] => offline;

/** Ask every paired server what it hosts and rebuild the map. Safe to call often; one pairing means no map. Returns what each server answered. */
async function askAll(): Promise<Record<string, Rows>> {
  const ids = await pairedBoxes();
  if (ids.length < 2) { map = {}; known = {}; offline = []; return {}; }
  const { peerCall } = await io();
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

/** Ask every server for its chats and learn which holds which. A server that does not answer keeps what was known of it. */
async function learnChats(input: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const ids = await pairedBoxes();
  const { peerCall } = await io();
  const got = await Promise.allSettled(ids.map((id) => peerCall<any>("work.chat.list", { limit: 200, ...input }, id)));
  const lists: Record<string, any> = {};
  ids.forEach((id, n) => { const r = got[n]; if (r.status === "fulfilled") lists[id] = r.value; });
  chatMap = { ...Object.fromEntries(Object.entries(chatMap).filter(([, b]) => !(b in lists))), ...chatServersFrom(lists) };
  return lists;
}

/** Every server's chats as one list, each row tagged with its server; null with fewer than two servers. */
export async function listAllChats(input: Record<string, unknown>): Promise<{ chats: Array<Record<string, any>> } | null> {
  if ((await pairedBoxes()).length < 2) return null;
  const lists = await learnChats(input);
  const chats: Array<Record<string, any>> = [];
  for (const [box, data] of Object.entries(lists)) for (const r of (Array.isArray(data) ? data : data?.chats ?? data?.rows ?? [])) if (r && typeof r === "object") chats.push({ ...r, server: box });
  return { chats };
}

/** The held acts of an approvals answer: a bare list, or { approvals, groups } as approvals.pending answers. */
const approvalRows = (v: any): any[] => (Array.isArray(v) ? v : Array.isArray(v?.approvals) ? v.approvals : []);

/**
 * The approvals inbox of every server as one answer, each held act tagged with its server (the same shape the screens already read: a bare list stays a list, { approvals, groups } stays that); null with fewer than
 * two servers. A server that did not answer keeps what was known of it.
 */
export async function listAllApprovals(tool: string, input: Record<string, unknown>): Promise<any | null> {
  const ids = await pairedBoxes();
  if (ids.length < 2) return null;
  const { peerCall } = await io();
  const got = await Promise.allSettled(ids.map((id) => peerCall<any>(tool, input, id)));
  const answers: Record<string, any> = {};
  ids.forEach((id, n) => { const r = got[n]; if (r.status === "fulfilled" && r.value && typeof r.value === "object") answers[id] = r.value; });
  if (!Object.keys(answers).length) { const bad = got.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined; throw bad?.reason ?? new Error("No server answered."); }
  const lists = Object.fromEntries(Object.entries(answers).map(([b, v]) => [b, approvalRows(v)]));
  approvalMap = { ...Object.fromEntries(Object.entries(approvalMap).filter(([, b]) => !(b in lists))), ...approvalServersFrom(lists) };
  const rows: Array<Record<string, any>> = [];
  for (const [box, list] of Object.entries(lists)) for (const r of list) if (r && typeof r === "object") rows.push({ ...r, server: box });
  if (Object.values(answers).every(Array.isArray)) return rows;
  const groups = Object.values(answers).flatMap((v: any) => (Array.isArray(v?.groups) ? v.groups : []));
  return { ...Object.values(answers).find((v) => !Array.isArray(v)), approvals: rows, groups };
}

/** A call that must reach EVERY paired server (the phone's push token): made to each; answers the first answer, and names the servers that did not get it (pushMissed) so the screen can say so. Throws only when none did. */
export async function callEvery<T = unknown>(tool: string, input: Record<string, unknown>): Promise<T> {
  const ids = await pairedBoxes();
  const { peerCall } = await io();
  const got = await Promise.allSettled(ids.map((id) => peerCall<T>(tool, input, id)));
  missed = ids.filter((_, n) => got[n].status === "rejected");
  const ok = got.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<T> | undefined;
  if (!ok) throw (got[0] as PromiseRejectedResult).reason;
  return ok.value;
}
/** The servers the last every-server call did not reach. */
export const pushMissed = (): string[] => missed;

/** Remember the ids an answer shows with the Space the call was for. Bounded: a long list keeps its newest. */
export function noteItems(answer: unknown, space: string | undefined): void {
  const got = itemSpacesFrom(answer, space);
  const ids = Object.keys(got);
  if (!ids.length) return;
  itemMap = mergeAmbiguous(itemMap, got);
  const all = Object.keys(itemMap);
  if (all.length > 20000) for (const k of all.slice(0, all.length - 20000)) delete itemMap[k];
}

/** A chat just made on a server is known to be there. */
export function noteChat(chat: string, box: string | undefined): void { if (chat && box) chatMap = mergeAmbiguous(chatMap, { [chat]: box }); }

/** Which server a call goes to. `server` is a box id when the call names one. Throws nothing: an error comes back to the caller to refuse in words. */
export async function routeCall(o: { tool?: string; input: Record<string, unknown>; showing: string; server?: string }) {
  const paired = await pairedBoxes();
  if (paired.length < 2 && !o.server) return { box: undefined };
  if (paired.length >= 2 && !Object.keys(map).length) await refreshSpaceServers().catch(() => {});
  const ask = () => serverFor({ tool: o.tool, explicit: o.server, input: o.input, showing: o.showing, spaceServers: map, paired, chatServers: chatMap, itemSpaces: itemMap, approvalServers: approvalMap });
  const r = ask();
  // a chat not known yet: ask every server which chats it holds, once, then decide; still unknown stays refused
  if (r.error?.code === "chat_unknown_server") { await learnChats().catch(() => {}); return ask(); }
  // a Space not in the map yet (a server that was offline when it was last asked, or a Space just made): ask every server once, then decide
  if (r.error?.code === "space_unknown_server") { await refreshSpaceServers().catch(() => {}); return ask(); }
  return r;
}

/** The server that hosts a Space, as far as it is known (box id), or null. */
export const serverOfSpace = (space: string): string | null => map[space] ?? null;
