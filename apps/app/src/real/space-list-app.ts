// The list of a person's servers and teams (space-list-flow.js) joined to this app: the vault's tools, this device's pairings and teams, the two counters it keeps, and the chain pairing the server lane provides.
// Four doors: `onVaultOpened` (the sign-in flows call it right after the master password opens the personal vault), `listFound` (Settings, Servers opens), `recordPaired` / `recordJoined` / `recordLeft`
// (the act the person already said yes to). Nothing reads in the background and nothing is cached past the screen: the counters are a number and a few ids, never the list.
import type { Pairing } from "../api/pairing";
import { makeListFlow } from "./space-list-flow.js";

type Tool = (name: string, input?: Record<string, unknown>) => Promise<any>;

const SEEN = "vyre.space-list.seen";
const PENDING = "vyre.space-list.pending";

/** The server's side of "admit a device the identity chain lists" (lane 2): given a listed server's pinned entry, pair this device to it with no typed code. Until it lands, a server answers `server_not_ready`. */
type ChainPairer = (e: { relay: string; route: string; box: string; name: string }) => Promise<Pairing>;
let connecting = 0;
const realChainPairer: ChainPairer = async (e) => {
  const { loadIdentity } = await import("../identity/store");
  const mine = await loadIdentity().catch(() => null);
  const { relayCrypto, relayKeyStore, about, deviceName } = await import("../api/relay");
  const client = (await import("@vyre/relay-client/client.js")) as unknown as { connect: (o: unknown) => any };
  const { chainHello } = (await import("@vyre/relay-client/chainhello.js")) as unknown as { chainHello: (o: unknown) => Promise<unknown> };
  const { chainPair } = await import("./chain-pair.js");
  const crypto = relayCrypto() as unknown as { sha256: (b: Uint8Array) => Promise<Uint8Array> };
  const p = await chainPair({ id: e.box, ...e }, {
    who: mine ? { id: mine.id, eid: mine.eid, sign: (m: Uint8Array) => mine.key.sign(m) } : null,
    crypto, keyStore: relayKeyStore(), about, name: deviceName(), connect: client.connect, chainHello,
  });
  return p as unknown as Pairing;
};
/**
 * Off until the server's chain admission (design B, lane 2) is signed and the server reports it: a listed server then answers `server_not_ready` and the person pairs it with a code. Turn it on with
 * `setChainPairer(realChainPairer)` only behind that capability; this branch must not ship with it on alone.
 */
let chainPairer: ChainPairer = async () => { throw Object.assign(new Error("That server does not admit this device yet. Pair it with a code from that server."), { code: "server_not_ready" }); };
export function setChainPairer(f: ChainPairer): void { chainPairer = f; }
export { realChainPairer };

const FROM_LIST = "vyre.space-list.fromlist";
/** The servers this device connected to from the list (not by the person's own pairing), so Servers can say so and offer Remove. */
export async function fromListBoxes(): Promise<string[]> {
  try { const { keyedText } = await import("../api/relay"); const j = JSON.parse((await keyedText.get(FROM_LIST)) || "[]"); return Array.isArray(j) ? j.filter((x: unknown) => typeof x === "string") : []; } catch { return []; }
}
async function markFromList(box: string): Promise<void> {
  try { const { keyedText } = await import("../api/relay"); const now = await fromListBoxes(); if (!now.includes(box)) await keyedText.set(FROM_LIST, JSON.stringify([...now, box])); } catch { /* the line is a courtesy */ }
}
/** Remove a server that came from the list: forget the pairing here and tell the list (a tombstone), so another device does not bring it back. */
export async function removeFromList(box: string): Promise<void> {
  const { removePairingFor, keyedText } = await import("../api/relay");
  await removePairingFor(box);
  try { await keyedText.set(FROM_LIST, JSON.stringify((await fromListBoxes()).filter((b) => b !== box))); } catch { /* none */ }
  await recordLeft(box);
}

/** The tool the vault calls go through. The personal vault is the person's own, not a Space's: it goes to the main server by name, never routed by the Space showing. */
async function vaultTool(): Promise<Tool> {
  const { tool } = await import("./box");
  const { loadPairing } = await import("../api/relay");
  const home = await loadPairing();
  return (name, input) => tool(name, input ?? {}, home ? { server: home.box } : {});
}

async function flowFor(given?: Tool) {
  const relay = await import("../api/relay");
  const { joinedTeams } = await import("./team-join");
  const kv = relay.keyedText;
  const num = async () => { try { const n = Number(await kv.get(SEEN)); return Number.isInteger(n) && n >= 0 ? n : 0; } catch { return 0; } };
  const ids = async () => { try { const j = JSON.parse((await kv.get(PENDING)) || "[]"); return Array.isArray(j) ? j.filter((x: unknown) => typeof x === "string") : []; } catch { return []; } };
  return makeListFlow({
    tool: given ?? (await vaultTool()),
    device: async () => ({ pairings: await relay.listPairings(), teams: joinedTeams() }),
    state: {
      seen: num,
      setSeen: async (n: number) => { try { await kv.set(SEEN, String(n)); } catch { /* the next read sets it */ } },
      pending: ids,
      setPending: async (p: string[]) => { try { if (p.length) await kv.set(PENDING, JSON.stringify(p)); else await kv.del(PENDING); } catch { /* kept for this run only */ } },
    },
    pairByChain: (e) => chainPairer(e),
    onPaired: async (p) => {
      // the list already names this server: pairing it must not read the vault a second time
      connecting++;
      void markFromList(p.box);
      try { const { afterPaired } = await import("./pairing"); await afterPaired({ relay: p.relay, route: p.route, box: p.box, name: p.name ?? "", device: (p as { device?: string }).device ?? "" }); } finally { connecting--; }
    },
  });
}

/** The master password just opened the personal vault: read the list once and connect every pinned server this device lacks. `vault` is the tool the sign-in already holds for the open vault, when it has one. */
export async function onVaultOpened(vault?: Tool) { return (await flowFor(vault)).opened(); }

/** Settings, Servers opens: read the list again. */
export async function listFound() { return (await flowFor()).sync(); }

/** Connect what a screen lists: one entry, or all of them. */
export async function connectFound(entries: Parameters<Awaited<ReturnType<typeof flowFor>>["connectAll"]>[0]) { return (await flowFor()).connectAll(entries); }

/** A server was paired here (the person's yes was the pairing itself). */
export async function recordPaired(p: { relay: string; route: string; box: string; name?: string }) { return connecting ? undefined : (await flowFor()).added(p); }

/** A team was joined here (the person's yes was the join). The device's teams are read as they are kept, so the list takes the new one. */
export async function recordJoined() {
  const { joinedTeams } = await import("./team-join");
  const newest = joinedTeams().sort((a, b) => b.at - a.at)[0];
  return newest ? (await flowFor()).added(newest) : undefined;
}

/** The person left a server (its box key) or a team (`team:<name>`) here. Not for a device wipe: wiping this device is not the person removing a server. */
export async function recordLeft(id: string) { return (await flowFor()).left(id); }
