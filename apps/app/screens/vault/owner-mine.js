// @ts-check
// The owner has no member vault: vault.me.* refuses them ("the owner uses the vault tools"). For the owner, "Mine" is the Space vault's own items read through vault.*; this is the switch, found once
// by that refusal, and the tool each Mine action calls for the owner. A member never reaches it: their status call answers, and they keep vault.me.*.

/** @param {(tool: string, input?: any) => Promise<any>} ask */
export function ownerMine(ask) {
  /** @type {Promise<boolean> | null} */ let owner = null;
  const isOwner = () => (owner ??= ask("vault.me.account.status").then(() => false, (/** @type {{ code?: string, message?: string }} */ e) => e.code === "denied" && /owner uses the vault tools/.test(String(e.message))));
  return {
    isOwner,
    /** the tool for a Mine action: the owner's is the vault.* one, a member's stays @param {string} tool */
    tool: async (tool) => (await isOwner() ? ({ "vault.me.put": "vault.put", "vault.me.remove": "vault.delete" }[/** @type {"vault.me.put"} */ (tool)] || tool) : tool),
  };
}
