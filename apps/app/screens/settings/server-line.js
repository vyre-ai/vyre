// @ts-check
// "Which server is this for." The screens that act on one server (updates, restarts, setup, sign-ins, settings) say whose it is when a device is paired to several. It follows the Space showing; under All spaces it is
// the main (active) server and the line says how to pick another. With one server paired it says nothing. Pure: the screen passes in the pairings, the Space-to-server map and what is showing.

/** @param {{ pairings: Array<{ box: string, name?: string }>, spaceServers: Record<string, string>, showing: string, active: string | null }} o */
export function serverLine(o) {
  if (o.pairings.length < 2) return "";
  const nameOf = (/** @type {string | null | undefined} */ box) => {
    const n = o.pairings.findIndex((p) => p.box === box);
    return n < 0 ? "" : (o.pairings[n].name || "").trim() || `Server ${n + 1}`;
  };
  const at = o.spaceServers[o.showing];
  if (at && nameOf(at)) return `This is for ${nameOf(at)}.`;
  const main = nameOf(o.active);
  return main ? `This is for ${main}, your main server. Pick a Space to act on another server.` : "";
}
