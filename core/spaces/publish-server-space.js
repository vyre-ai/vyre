// @ts-check
// spaces.publish-server-space: give a paired server's OWN space its name in the names directory, from this computer. The same three steps the app's page does for a space it makes
// (apps/app/src/real/claim-space.ts nameServerOwnSpace), with the pieces this computer already has: the server makes its space's root key (spaces.name-here), this computer's identity signs the
// directory record (names.claimSpace, the one claim spaces.create also uses), and the server keeps the name once the directory answers it (spaces.name-here with `done`). One copy of each step.
// Owner only: the server steps go through the chosen-server door, which refuses anyone but this home's owner.

const DENY = "Only this home's owner can name a space on a server.";

/**
 * @param {{ tool: (name: string, description: string, input: any, run: (i: any, meta: any) => Promise<any>) => void, obj: (p: any, r?: string[]) => any, str: any, refuse: (m: string, c: string) => Error,
 *   chosen: { onChosenServer: (tool: string, i: any, meta: any, keys: string[], deny: string) => Promise<any> }, local?: (i: { name: string, done?: boolean }, meta: any) => Promise<any>, names: { claimSpace: (a: { name: string, rootPublic: string, record: any }) => Promise<any> } }} d
 */
export function registerPublishServerSpace(d) {
  d.tool("spaces.publish-server-space", "Name a paired server's own space in the names directory, so its address answers sign-in. Asks the server for the space's key, publishes the record signed by this computer's identity, then has the server keep the name. Owner only.",
    d.obj({ server: d.str, name: d.str, local: { type: "boolean" } }, ["name"]), async (i, meta) => {
      const label = String(i.name || "").trim().toLowerCase().replace(/\.vyre\.run$/, "");
      if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(label)) throw d.refuse("That is not a space name. Use 2 to 31 letters, digits or hyphens.", "bad_name");
      const server = String(i.server || "");
      // `local`: this daemon IS the server (it redeemed its own install line), so its own space is named here, by the same handler a paired server runs; the owner check is that handler's own
      const here = i.local === true && !server && typeof d.local === "function";
      if (!here && !server) throw d.refuse("Say which server this is for, or that this computer is the server. Nothing was changed.", "bad_input");
      const run = (/** @type {any} */ x) => (here ? /** @type {any} */ (d.local)(x, meta) : d.chosen.onChosenServer("spaces.name-here", { server, ...x }, meta, ["name", "done"], DENY));
      const made = await run({ name: label });
      if (!made || typeof made.space !== "string" || typeof made.rootPublic !== "string") throw d.refuse("The server did not give its space's key. Nothing was published.", "unavailable");
      const claimed = await d.names.claimSpace({ name: label, rootPublic: made.rootPublic, record: { spaceId: made.space, displayName: label } });
      if (!claimed || claimed.ok !== true) throw d.refuse(String((claimed && claimed.message) || "The names directory did not take that name."), String((claimed && claimed.code) || "taken"));
      await run({ name: label, done: true });
      return { space: made.space, name: label };
    });
}
