// "Add this device to my name" (team/0.3/UX-AUDIT.md): this device has no key yet. The device that holds the name shows a code (wink.phone.open): the QR or long code, or the short typed code. This device
// makes its own key, redeems the code over the relay (relay/client/phonepair.js addThisDevice), and when the person says yes at the other device that device puts this key on the name's list at the
// names directory. Then this device reads the list, checks that its key is on it, and keeps the name. Nothing is kept until the list holds this device. The screen shows its own sentence for each `.code`.
//
//   bad_code, taken, busy, unreachable, denied, expired, cancelled   from the pairing (phonepair.js)
//   not_enrolled   the other device could not put this key on the list
//   not_listed     the pairing finished but the directory's list does not hold this device (yet)
//   exists         this device already holds a name

import { agreePublic } from "./agree";
import { shellKeyHeld } from "./mac-key.ts";
import * as C from "../../../../kernel/identity/chain.js";
import { addThisDevice as pair } from "@vyre/relay-client/phonepair.js";
import { about, presenceKey, relayCrypto, relayKeyStore } from "../api/relay";
import { afterPaired } from "../real/pairing";
import { relayUrl } from "../api/relay-url";
import { addDeviceCore } from "./add-device-core.js";
import { generateDeviceKey } from "./keys.js";
import { loadIdentity, saveIdentity } from "./store.ts";

const DIRECTORY = (process.env.EXPO_PUBLIC_VYRE_NAMES_DIRECTORY || "https://names.vyre.run").replace(/\/+$/, "");
const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

export type AddOpts = {
  /** The QR or the long code. */
  payload?: string;
  /** The short typed code (WINK-NNPP-PPPP): the relay is this app's own. */
  code?: string;
  deviceLabel: string;
  onWords?: (words: string) => void;
  onAck?: (ack: string) => void;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  base?: string;
  now?: () => number;
};

/** Add this device to the name held by another device. Resolves the name once this device holds it. */
export async function addDeviceToName(o: AddOpts): Promise<{ name: string; id: string }> {
  const f = o.fetch ?? globalThis.fetch;
  const base = (o.base ?? DIRECTORY).replace(/\/+$/, "");
  const now = o.now ?? Date.now;
  let key: Awaited<ReturnType<typeof generateDeviceKey>> | null = null;
  return addDeviceCore({
    held: async () => Boolean(await loadIdentity().catch(() => null)),
    makeKey: async () => (key = await generateDeviceKey()),
    agree: () => agreePublic(),
    pageHeld: () => shellKeyHeld(),
    pair: async ({ key: k, onWords, onAck, signal }) => pair({
      // The key this device signs its paired session with is the presence key reported here, never the identity key (platform-3).
      ...(await presenceKey() ? { presenceKey: await presenceKey() } : {}),
      ...(o.payload !== undefined ? { payload: o.payload } : { code: o.code, relay: relayUrl() }),
      key: k, name: o.deviceLabel, crypto: relayCrypto(), keyStore: relayKeyStore(), about,
      ...(onWords ? { onWords } : {}), ...(onAck ? { onAck } : {}), ...(signal ? { signal } : {}),
    }),
    readList: async (name) => {
      let res: Response;
      try { res = await f(`${base}/v1/ids/resolve?name=${encodeURIComponent(name)}`, { headers: { accept: "application/json" } }); } catch { throw fail("unreachable", "The names directory did not answer."); }
      const json: any = await res.json().catch(() => null);
      const ops: any[] = json && json.data && Array.isArray(json.data.ops) ? json.data.ops : [];
      try { const st = await C.verifyChain(ops, { now: now() + C.SKEW_MS }); return { ops, id: st.id, eids: st.entries.map((e: any) => e.eid), pin: C.pinOf(st) }; } catch { return null; }
    },
    save: (i) => saveIdentity({ ...i, key: key as NonNullable<typeof key> }),
    // The pairing also reaches that computer, so Now has something to show.
    keepPairing: (p) => afterPaired(p),
  }, { deviceLabel: o.deviceLabel, onWords: o.onWords, onAck: o.onAck, signal: o.signal });
}

/** The words for each way adding this device can end. @param {string | undefined} code */
export function addSay(code: string | undefined): string {
  if (code === "bad_code") return "That is not a code for adding a device. On the device that has your name, choose Devices, then Add a device.";
  if (code === "taken") return "That code was already used or has run out. Make a new one on the other device.";
  if (code === "busy") return "Too many tries. Wait a minute, then try again.";
  if (code === "unreachable") return "Vyre cannot reach the other device right now. Nothing was added. Try again.";
  if (code === "denied") return "Nothing was added: the other device said no, or the words did not match. Start again from the other device.";
  if (code === "expired") return "Nobody answered on the other device in time. Nothing was added. Make a new code there.";
  if (code === "cancelled") return "Adding this device was cancelled.";
  if (code === "not_enrolled") return "The other device could not add this one. Nothing was added.";
  if (code === "not_listed") return "The other device said yes, but your list does not hold this device yet. Try again in a minute.";
  if (code === "exists") return "This device already holds a name.";
  return "Adding this device did not work. Nothing was added.";
}
