import { router } from "expo-router";
import { viewCache } from "../state/cache";
import { forgetPersonSlots } from "../auth/person.native";
import { boxName } from "../api/box.native";
import { loadPairing, savePairing, forgetRelayKey } from "../api/relay.native";
import { forgetIdentity } from "./store.native";
import { closePeer, usePeer } from "../real/peer";
import { disconnect } from "../api/box";
import type { WipeStep } from "./wipe.js";

/** What a phone holds: the identity seed and record, the relay key, the pairing and its session token, the signer's keys (the Secure Enclave or Keystore ones), the cache. */
export const deviceSteps = (): WipeStep[] => [
  { name: "device keys", run: async () => {
    await forgetIdentity();
    await forgetRelayKey();
    const m = (await import("../../modules/vyre-signer")) as unknown as { wipePresence?: () => Promise<void> };
    await m.wipePresence?.();
  } },
  { name: "settings and pins", run: async () => { await viewCache.clear(); } },
  { name: "recent views", run: async () => { await viewCache.clear(); } },
  // a phone's outbox lives in memory with the connection: closing the connection drops what was waiting
  { name: "outbox", run: async () => { disconnect(); } },
  { name: "cached app files", run: async () => { /* a phone build carries its files in the app, not in a cache */ } },
  { name: "unlock session", run: async () => {
    const p = await loadPairing().catch(() => null);
    await forgetPersonSlots([...new Set([boxName(), ...(p?.route ? [p.route] : [])])]);
  } },
  { name: "pairing", run: async () => {
    await savePairing(null);
    usePeer(false);
    closePeer();
  } },
];

export function afterWipe(): void { router.replace("/"); }
