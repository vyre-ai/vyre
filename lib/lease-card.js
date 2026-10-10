// @ts-check
// Who signs a lease request on a lent computer (R031-95 2.2, review row 1). The Space's home asks this computer to sign its hello with the person's key that is listed for it (the Secure Enclave of a Mac, the TPM of a PC);
// that key lives in the app on this computer, never in vyred. So the runner puts the request on this computer's own approvals queue as a card, the app shows it, the person says yes with the key, and the signed proof
// comes back to the one remote call that is waiting for it. Nothing here signs or checks a signature: the home's sealing process does both.

/**
 * The remote kernel's signer for `leases.issue`: ask for the card, wait for the person, give back `{ presence }`. Throws `needs_presence` when nobody answers in time or the person says no.
 * @param {{ challenge: any, call: (tool: string, input: any) => Promise<any>, waitMs?: number, pollMs?: number, sleep?: (ms: number) => Promise<void>, now?: () => number }} o
 * @returns {Promise<{ presence: any }>}
 */
export async function askLeaseProof(o) {
  const ch = o.challenge;
  const no = (/** @type {string} */ why) => Object.assign(new Error(why), { code: "needs_presence" });
  if (!ch || ch.call !== "leases.issue" || typeof ch.space !== "string" || typeof ch.home !== "string" || typeof ch.nonce !== "string" || !ch.fields || typeof ch.fields !== "object") throw no("the home's request is not one this computer can sign");
  const asked = await o.call("approvals.lease-ask", { space: ch.space, fields: ch.fields, home: ch.home, challenge: ch.nonce });
  if (!asked || asked.error || !asked.data || typeof asked.data.id !== "string") throw no("this computer could not ask you to approve lending it");
  const id = asked.data.id, now = o.now || Date.now, sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const end = now() + (o.waitMs ?? 105_000);
  for (;;) {
    const st = await o.call("approvals.lease-status", { id });
    const d = st && st.data;
    if (d && d.state === "approved" && d.proof) return { presence: d.proof };
    if (st && st.error || !d || d.state !== "waiting") throw no("lending this computer was not approved");
    if (now() >= end) throw no("lending this computer was not approved in time");
    await sleep(o.pollMs ?? 400);
  }
}
