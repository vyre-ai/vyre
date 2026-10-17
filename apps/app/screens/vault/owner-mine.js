// @ts-check
// The owner has no "member's own vault": vault.me.* refuses the owner by design ("the owner uses the vault tools", core/vault/tools/me.js ME_REFUSAL). So when the Mine tab is asked for by the
// owner, the screen shows the owner's vault (the vault.* tools) under it instead of the refusal; a member keeps vault.me.*.

/** Is this the server's "the owner uses the vault tools" refusal of a vault.me.* call? @param {any} e */
export const isOwnerRefusal = e => Boolean(e) && e.code === "denied" && /the owner uses the vault tools/.test(String(e.message || ""));

/** The scope whose tools a call uses: the owner's Mine is the Space vault. @param {boolean} owner @param {"space" | "mine"} scope @returns {"space" | "mine"} */
export const toolScope = (owner, scope) => (owner ? "space" : scope);

/**
 * The Mine connection-share panel's two calls. For the owner (vault.me.connection.* refuses them) they are the Space vault's sharing (vault.access.*); for a member, her own.
 * @param {() => boolean} isOwner @param {() => { load: Function, set: Function }} space the Space vault's sharing @param {{ load: Function, set: Function }} own the member's
 */
export const connectionSharingFor = (isOwner, space, own) => ({
  load: (/** @type {any} */ item) => (isOwner() ? space().load(item) : own.load(item)),
  set: (/** @type {any} */ item, /** @type {any} */ w, /** @type {any} */ level) => (isOwner() ? space().set(item, w, level) : own.set(item, w, level)),
});
