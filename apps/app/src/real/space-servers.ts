// Which paired server hosts which Space, for a device paired to more than one (the phone, the browser, Windows): the map is built from what each server says it hosts (its own spaces.list), and the call that
// asks (src/real/box.ts tool) routes by it (server-route.js). With one pairing there is nothing to route, so the map is empty and every call goes where it always went. A server that does not answer is
// given SERVER_WAIT_MS and then left quiet for a minute, so one silent server never holds the others, and a call for the Space showing goes to its server without waiting on the rest.
import { approvalServersFrom, mergeAmbiguous, chatServersFrom, itemSpacesFrom, mergeSpaceLists, serverFor, spaceServersFrom } from "./server-route.js";
import { NOT_ANSWERING_SAY } from "./not-answering.js";
import { askBox, clearQuiet, isQuiet, quietServers, resetServerQuiet, setServerClock, type Asked } from "./server-wait";

export { setServerClock, QUIET_FOR_MS, SERVER_WAIT_MS as CHATS_SERVER_MS } from "./server-wait";

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
export function setPorts(p: Ports | null): void { ports = p; multi = false; primed = null; map = {}; known = {}; boxes = null; chatMap = {}; itemMap = {}; approvalMap = {}; missed = []; watching = false; resetServerQuiet(); setServerClock(null); }
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

/** The servers that did not answer and are still quiet (box ids). The switcher says "Not answering" for their Spaces. */
export const offlineServers = (): string[] => quietServers();

/** Drop one server from what this device learned, after the person removes it. */
export function forgetServer(box: string): void {
  if (!box) return;
  clearQuiet(box);
  delete known[box];
  for (const [sp, b] of Object.entries(map)) if (b === box) delete map[sp];
  for (const [id, b] of Object.entries(chatMap)) if (b === box) delete chatMap[id];
  for (const [id, b] of Object.entries(approvalMap)) if (b === box) delete approvalMap[id];
}

const SPACE_ID = /^spc_[a-z2-7]{12}$/;
const URN_SPACE = /^vyre:\/\/(spc_[a-z2-7]{12})\//;
/** The Space a call is for: the one its record address names, else the one it names, else the one showing. */
function spaceOf(o: { input: Record<string, unknown>; showing: string }): string {
  const urn = typeof o.input.urn === "string" ? URN_SPACE.exec(o.input.urn) : null;
  if (urn) return urn[1];
  if (typeof o.input.space === "string" && SPACE_ID.test(o.input.space)) return o.input.space;
  return SPACE_ID.test(o.showing) ? o.showing : "";
}

async function askOne<T>(id: string, tool: string, input: Record<string, unknown>): Promise<Asked<T>> {
  const { peerCall } = await io();
  return askBox(() => peerCall<T>(tool, input, id), id);
}

/** Fold one server's spaces.list into the map. A miss keeps what was known. */
function noteSpaces(id: string, r: Asked<Rows>): void {
  known = { ...known, [id]: r.status === "ok" && Array.isArray(r.value) ? r.value : (known[id] ?? []) };
  map = spaceServersFrom(known);
}

/** Ask every paired server what it hosts and rebuild the map. A quiet server is not asked. One pairing means no map. */
async function askAll(): Promise<Record<string, Rows>> {
  const ids = await pairedBoxes();
  if (ids.length < 2) { map = {}; known = {}; resetServerQuiet(); return {}; }
  const got = await Promise.all(ids.map((id) => askOne<Rows>(id, "spaces.list", {})));
  ids.forEach((id, n) => noteSpaces(id, got[n]));
  const any = got.some((r) => r.status === "ok" && Array.isArray(r.value));
  if (!any) { const bad = got.find((r) => r.status === "down") as { error: unknown } | undefined; throw bad?.error ?? new Error("No server answered."); }
  return known;
}

/** Ask until the Space's own server has answered, then stop. The others finish in the background and a silent one is marked quiet when its time runs out. */
async function askUntilSpace(space: string): Promise<void> {
  if (map[space]) return;
  const ids = (await pairedBoxes()).filter((id) => !isQuiet(id));
  if (!ids.length) return;
  await new Promise<void>((resolve) => {
    let left = ids.length;
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    for (const id of ids) {
      void askOne<Rows>(id, "spaces.list", {}).then((r) => {
        noteSpaces(id, r);
        left -= 1;
        if (map[space] || left === 0) finish();
      });
    }
  });
}

export async function refreshSpaceServers(): Promise<Record<string, string>> { await askAll().catch(() => {}); return map; }

/** The Spaces of every paired server, each row tagged with its server; null when the device has fewer than two servers (the caller then asks its one server as it always did). A server that is down keeps its last known rows. */
export async function listAllSpaces(): Promise<Array<Record<string, any>> | null> {
  if ((await pairedBoxes()).length < 2) return null;
  return mergeSpaceLists(await askAll());
}

/** Ask every server for its chats and learn which holds which. A server that does not answer within SERVER_WAIT_MS is quiet and keeps what was known of it. */
async function learnChats(input: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const ids = await pairedBoxes();
  const got = await Promise.all(ids.map((id) => askOne<any>(id, "work.chat.list", { limit: 200, ...input })));
  const lists: Record<string, any> = {};
  ids.forEach((id, n) => { const r = got[n]; if (r.status === "ok") lists[id] = r.value; });
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
  const got = await Promise.all(ids.map((id) => askOne<any>(id, tool, input)));
  const answers: Record<string, any> = {};
  ids.forEach((id, n) => { const r = got[n]; if (r.status === "ok" && r.value && typeof r.value === "object") answers[id] = r.value; });
  if (!Object.keys(answers).length) { const bad = got.find((r) => r.status === "down") as { error: unknown } | undefined; throw bad?.error ?? new Error("No server answered."); }
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
  const got = await Promise.all(ids.map((id) => askBox(() => peerCall<T>(tool, input, id), id)));
  missed = ids.filter((_, n) => got[n].status !== "ok");
  const ok = got.find((r) => r.status === "ok") as { value: T } | undefined;
  if (!ok) throw (got.find((r) => r.status === "down") as { error: unknown } | undefined)?.error ?? new Error("No server answered.");
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

/** A call whose server is quiet is refused in words. The caller does not wait on it. */
function say<T extends { box?: string; error?: { code: string; message: string } }>(r: T): T {
  if (r.box && isQuiet(r.box)) return { error: { code: "server_not_answering", message: NOT_ANSWERING_SAY } } as T;
  if (r.error?.code === "space_unknown_server" && quietServers().length) return { error: { code: "server_not_answering", message: NOT_ANSWERING_SAY } } as T;
  return r;
}

/** Which server a call goes to. `server` is a box id when the call names one. Throws nothing: an error comes back to the caller to refuse in words. A Space that is showing is resolved from its own server without waiting on the others. */
export async function routeCall(o: { tool?: string; input: Record<string, unknown>; showing: string; server?: string }) {
  const paired = await pairedBoxes();
  if (paired.length < 2 && !o.server) return { box: undefined };
  const ask = () => serverFor({ tool: o.tool, explicit: o.server, input: o.input, showing: o.showing, spaceServers: map, paired, chatServers: chatMap, itemSpaces: itemMap, approvalServers: approvalMap });
  if (!o.server) { const need = spaceOf(o); if (need && !map[need]) await askUntilSpace(need); }
  let r = ask();
  // a chat not known yet: ask every server which chats it holds, once, then decide; still unknown stays refused
  if (r.error?.code === "chat_unknown_server") { await learnChats().catch(() => {}); r = ask(); }
  // a Space not in the map yet (a server that was offline when it was last asked, or a Space just made): ask every server once, then decide
  if (r.error?.code === "space_unknown_server") { await refreshSpaceServers().catch(() => {}); r = ask(); }
  return say(r);
}

/** The server that hosts a Space, as far as it is known (box id), or null. */
export const serverOfSpace = (space: string): string | null => map[space] ?? null;
