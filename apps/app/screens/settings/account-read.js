// @ts-check
// Account on a page that holds no key of the person's own (a browser or a phone on a server's address): the server holds no identity ("exists: false": the keys are on the person's Mac or phone), but it knows
// who its person is by name. This says that person, and reads their list from the names directory, checked. The page can show the list and cannot change it. Pure: the calls are passed in.

/** @typedef {(tool: string, input?: Record<string, unknown>) => Promise<{ data?: any, error?: { code: string, message: string } }>} Call */

/** The person the server knows, or null. @param {Call} call */
export async function personOfServer(call) {
  const r = await call("onboard.status", {});
  const username = typeof r.data?.person === "string" ? r.data.person.trim() : "";
  if (!username) return null;
  const label = typeof r.data?.accountName === "string" && r.data.accountName.trim() ? r.data.accountName.trim() : username;
  return { username, label };
}

/**
 * The identity to show when the box has none: the person the server knows, marked read-only; the box's own answer when it knows no one.
 * @param {Call} call @param {{ exists: boolean }} own what spaces.identity.status said
 */
export async function readOnlyIdentity(call, own) {
  const who = await personOfServer(call).catch(() => null);
  return who ? { exists: true, name: who.username, label: who.label, readOnly: true } : own;
}

/**
 * The person's list from the directory (no key needed). Empty when the server knows no one or the directory has no id for the name.
 * @param {Call} call @param {(id: string) => Promise<any[]>} read reads and verifies the chain of an id
 */
export async function readOnlyEntries(call, read) {
  const who = await personOfServer(call).catch(() => null);
  if (!who) return [];
  const r = await call("spaces.identity.resolve", { name: who.username });
  const id = typeof r.data?.id === "string" ? r.data.id : "";
  return id ? read(id) : [];
}
