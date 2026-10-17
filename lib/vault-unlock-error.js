// @ts-check
// vault-unlock-error: a locked person or space vault, with which unlock tool the UI should offer.

/**
 * @param {{ vault: "person" | "space", message?: string }} o
 */
export function vaultLockedError({ vault, message }) {
  const unlock = vault === "person" ? "vault.me.account.unlock" : "vault.account.unlock";
  const msg = message || (vault === "person"
    ? "Your vault is locked. Unlock it to save your browser sign-in."
    : "The Vault is locked. Unlock it to save agent browser profiles.");
  return Object.assign(new Error(msg), { code: vault === "space" ? "vault_locked" : "locked", detail: { unlock, vault } });
}
