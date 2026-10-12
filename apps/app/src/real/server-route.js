// @ts-check
// Which paired server a call goes to, when a device is paired to several. One rule: the server follows the Space. A call that names a server (the Space-making calls, which name a server and no Space yet) goes
// there; else the server that hosts the Space the call is for; else the one that hosts the Space showing; else the active one (box undefined). A server this device is not paired to is never swapped for another:
// it is refused in words that name the next step. Pure; src/real/space-servers.ts keeps the map and src/real/box.ts asks it.

const SPACE = /^spc_[a-z2-7]{12}$/;
const NOT_PAIRED = "This device is not paired to that server. Add it in Settings, Servers, then try again.";

/**
 * @param {{ explicit?: string, input?: Record<string, unknown>, showing?: string, spaceServers: Record<string, string>, paired: string[] }} o
 * @returns {{ box?: string, error?: { code: string, message: string } }}
 */
export function serverFor(o) {
  const refuse = () => ({ error: { code: "server_not_paired", message: NOT_PAIRED } });
  if (o.explicit) return o.paired.includes(o.explicit) ? { box: o.explicit } : refuse();
  const named = o.input && typeof o.input.space === "string" ? o.input.space : "";
  const space = SPACE.test(named) ? named : SPACE.test(o.showing ?? "") ? /** @type {string} */ (o.showing) : "";
  const box = space ? o.spaceServers[space] : undefined;
  if (!box) return { box: undefined };
  return o.paired.includes(box) ? { box } : refuse();
}

/**
 * The Space-to-server map from what each paired server says it hosts (its own spaces.list). A row for a team the person only JOINED (`member`) is not hosted there; a Space listed by two servers stays with the first.
 * @param {Record<string, Array<{ id?: unknown, member?: unknown } | null> | undefined>} lists by box id
 * @returns {Record<string, string>}
 */
export function spaceServersFrom(lists) {
  /** @type {Record<string, string>} */ const out = {};
  for (const [box, rows] of Object.entries(lists)) {
    for (const r of rows ?? []) {
      const id = r && typeof r.id === "string" ? r.id : "";
      if (SPACE.test(id) && r && r.member !== true && !out[id]) out[id] = box;
    }
  }
  return out;
}
