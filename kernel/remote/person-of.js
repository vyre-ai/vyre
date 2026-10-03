// kernel/remote/person-of.js: the product `personOf` for kernel/remote/wink.js: which person a proven device belongs to, from the identity chain's LIVE device list.
// The transport proves a device id (`device:<id>` from the Wink node or the relay pairing); the id is the device's entry id (`eid`) on a person's signed list
// (kernel/identity/chain.js), so a device the person removed is on nobody's list and maps to nobody at its very next call. Nothing is cached here: `stateOf` is read on every
// call and must return the person's current verified state (the identity module syncs it), and only people who are members of the Space are asked.
/**
 * @param {{ people: () => string[] | Promise<string[]>, stateOf: (person: string) => Promise<{ entries: { eid: string, kind: string }[] } | null | undefined> }} d
 *   people: the Space's members and invitees that hold an identity (the members list, plus the invite's named person while it is pending).
 * @returns {(device: string) => Promise<string | null>}
 */
export function personOfChains(d) {
  return async device => {
    if (typeof device !== "string" || !device) return null;
    let found = null;
    for (const person of await d.people()) {
      let state = null;
      try { state = await d.stateOf(person); } catch { state = null; }
      if (state && state.entries.some(e => e.kind === "device" && e.eid === device)) {
        if (found !== null && found !== person) return null; // one device on two people's lists is no one's: never guess
        found = person;
      }
    }
    return found;
  };
}
