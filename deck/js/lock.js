// @ts-check
// Tailnet Lock's words, shared by the onboarding's optional card and Settings' Network row, so
// both say the same thing. The data is onboard.tailscale's "lock" answer: whether the lock is on,
// this box's lock key, and the commands. Vyre only reads the lock; every command here is one the
// person runs themselves, on their Mac.

export const LOCK = {
  title: "Lock your tailnet",
  what: "With Tailnet Lock, a new device must be signed by a device you trust before it can join your tailnet. So even someone who steals your Tailscale login cannot add a machine.",
  cost: "The cost: every new device needs that signature first. If you lose every signing device and the disablement secrets too, you are locked out of changing it.",
  show: "Show me the commands",
  hide: "Hide the commands",
  later: "Not now",
  laterNote: "You can lock your tailnet later, from Settings.",
  never: "Vyre never runs these. Run them yourself, on your Mac, where you can see what they do.",
};

/**
 * What the lock is doing now, in one sentence, or null while it is off.
 * @param {{ enabled?: boolean, signed?: boolean|null, trusted?: number|null }} d
 */
export function lockState(d) {
  if (!d.enabled) return null;
  const keys = d.trusted ? ` Your tailnet trusts ${d.trusted} signing ${d.trusted === 1 ? "key" : "keys"}.` : "";
  if (d.signed === true) return "Tailnet Lock is on, and your server is signed." + keys;
  if (d.signed === false) return "Tailnet Lock is on, but your server is not signed yet. Sign it from a device you trust, with tailscale lock sign or in the Tailscale admin console." + keys;
  return "Tailnet Lock is on." + keys;
}

/**
 * The steps to turn the lock on, in order: what to do, and the command or key to copy (null
 * when there is nothing to copy).
 * @param {{ key?: string|null, why?: string|null, commands?: { mac: string, init: string } }} d
 * @returns {{ text: string, copy: string|null }[]}
 */
export function lockSteps(d) {
  const c = d.commands || { mac: "tailscale lock", init: `tailscale lock init --gen-disablements 2 --gen-disablement-for-support <mac key> ${d.key || "<box key>"}` };
  return [
    { text: "On your Mac, read its key. It is the one that starts with tlpub:", copy: c.mac },
    d.key ? { text: "Your server's key:", copy: d.key }
      : { text: `Your server did not give its key${d.why ? ` (${d.why})` : ""}. Check again once Tailscale is running here.`, copy: null },
    { text: "On your Mac, run this, with your Mac's key in place of <mac key>:", copy: c.init },
    { text: "It prints two disablement secrets. Save both in the Vault. Either one turns the lock off if every signing device is lost, and Tailscale support keeps one more.", copy: null },
  ];
}
