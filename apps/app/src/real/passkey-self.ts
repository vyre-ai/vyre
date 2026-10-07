import { loadIdentity } from "../identity/store";
import { passkeyPresenceKey } from "../identity/passkey.js";
import { approveCard, cardsFrom } from "./phone-approve.js";
import { proofHeader } from "./approvals.js";
import { signPresenceWithPasskey } from "./passkey-signer.js";

/** A passkey browser answers the card it just asked: fetch it from approvals.pending, sign it with the passkey and send approvals.answer with the proof beside it. Nothing happens unless this device's identity is a passkey. */
export async function passkeySelf(call: (tool: string, input?: Record<string, unknown>) => Promise<any>, id: string): Promise<void> {
  const mine = await loadIdentity();
  const key = mine?.key as { sign(m: Uint8Array): Promise<Uint8Array>; keep(): unknown } | undefined;
  if (!mine || !key || !passkeyPresenceKey(key.keep() as never)) return;
  const card = cardsFrom(await call("approvals.pending", {})).find((c) => c.id === id);
  if (!card) return;
  const signer = { signPresence: (req: { op: string; space: string; fields: Record<string, any>; payload_hash: string; person: string }) => signPresenceWithPasskey(req, { key }) };
  await approveCard(card, signer as never, call as never, proofHeader, mine.id);
}
