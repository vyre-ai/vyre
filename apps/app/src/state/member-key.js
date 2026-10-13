// The Secret Key of a member's own vault lives on this device and nowhere on the server: it is saved when the vault is made and sent with the master password at each unlock. `store` is { get(acct), put(acct, key), remove(acct) }.
// A device that does not hold the key cannot unlock: it says so, and the key arrives from a device that has it (the approved sign-in), never by typing.

/** A store over a plain key-value (the app's secure store on a phone, the browser's storage on the web). @param {{ get: (k: string) => Promise<string | null>, set: (k: string, v: string | null) => Promise<void> }} kv */
export const deviceKeyStore = (kv) => ({
  get: async (/** @type {string} */ acct) => kv.get("vyre.me.sk." + acct),
  put: async (/** @type {string} */ acct, /** @type {string} */ key) => kv.set("vyre.me.sk." + acct, key),
  remove: async (/** @type {string} */ acct) => kv.set("vyre.me.sk." + acct, null),
});

/** Make the member's vault and keep its Secret Key on this device. The key is never returned to the screen. @param {(tool: string, input?: any) => Promise<any>} ask */
export async function createMine(ask, store, password) {
  const r = await ask("vault.me.account.create", { password });
  if (!r || typeof r.secretKey !== "string" || !r.acct) throw new Error("the vault was made but its key did not come back");
  await store.put(r.acct, r.secretKey);
}

/** Unlock with the password and the key this device holds. @param {(tool: string, input?: any) => Promise<any>} ask */
export async function unlockMine(ask, store, password) {
  const st = await ask("vault.me.account.status");
  if (!st || !st.account) throw Object.assign(new Error("you have no vault yet"), { code: "no_account" });
  const key = st.acct ? await store.get(st.acct) : null;
  if (!key) throw Object.assign(new Error("this device does not hold your vault's Secret Key. Open Vyre on a device that does and approve this one."), { code: "no_device_key" });
  await ask("vault.me.account.unlock", { password, secretKey: key });
}

/** Whether the member has a vault at all. @param {(tool: string, input?: any) => Promise<any>} ask */
export async function hasMine(ask) { const st = await ask("vault.me.account.status"); return Boolean(st && st.account); }
