// @ts-check
// lib/own-row: the hub row a member's call means. The name she gives is her label, the row's key is hers (`personKey`), and it must be hers: a member never reaches the owner's row of the same name, nor another
// member's. The owner, and home work with no person, reach a row by the name given. Shared by the mcp module's update, remove, test, restart and repin.

/** @param {{ row(key: string): any }} hub @param {(label: string, person: string) => string} personKey @param {string} name @param {string} person the member's id, or "" for the owner and home work */
export function ownRow(hub, personKey, name, person) {
  if (!person) return name;
  const key = personKey(String(name), person), r = hub.row(key);
  if (!r || r.owner !== person) throw Object.assign(new Error(`you have no server named ${String(name).slice(0, 40)}: check the name under Your accounts, or add a server of your own there`), { code: "not_found" });
  return key;
}
