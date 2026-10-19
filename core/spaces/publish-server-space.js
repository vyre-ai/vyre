// @ts-check
// spaces.publish-server-space: give a paired server's OWN space its name in the names directory, from this computer. The same three steps the app's page does for a space it makes
// (apps/app/src/real/claim-space.ts nameServerOwnSpace), with the pieces this computer already has: the server makes its space's root key (spaces.name-here), this computer's identity signs the
// directory record (names.claimSpace, the one claim spaces.create also uses), and the server keeps the name once the directory answers it (spaces.name-here with `done`). One copy of each step.
// Owner only: the server steps go through the chosen-server door, which refuses anyone but this home's owner.

const DENY = "Only this home's owner can name a space on a server.";

/**
 * @param {{ tool: (name: string, description: string, input: any, run: (i: any, meta: any) => Promise<any>) => void, obj: (p: any, r?: string[]) => any, str: any, refuse: (m: string, c: string) => Error,
 *   chosen: { onChosenServer: (tool: string, i: any, meta: any, keys: string[], deny: string) => Promise<any> }, names: { claimSpace: (a: { name: string, rootPublic: string, record: any }) => Promise<any> },
 *   listServer: (a: { name: string, server: string }) => Promise<any> }} d
 */
export function registerPublishServerSpace(d) {
  d.tool("spaces.publish-server-space", "Name a paired server's own space in the names directory, so its address answers sign-in. Asks the server for the space's key, publishes the record signed by this computer's identity, then has the server keep the name. Owner only.",
    d.obj({ server: d.str, name: d.str }, ["server", "name"]), async (i, meta) => {
      const label = String(i.name || "").trim().toLowerCase().replace(/\.vyre\.run$/, "");
      if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(label)) throw d.refuse("That is not a space name. Use 2 to 31 letters, digits or hyphens.", "bad_name");
      const server = String(i.server || "");
      const made = await d.chosen.onChosenServer("spaces.name-here", { server, name: label }, meta, ["name", "done"], DENY);
      if (!made || typeof made.space !== "string" || typeof made.rootPublic !== "string") throw d.refuse("The server did not give its space's key. Nothing was published. Check that the server is online in Devices, then run spaces.publish-server-space again.", "unavailable");
      const claimed = await d.names.claimSpace({ name: label, rootPublic: made.rootPublic, record: { spaceId: made.space, displayName: label } });
      if (!claimed || claimed.ok !== true) throw d.refuse(String((claimed && claimed.message) || "The names directory did not take that name."), String((claimed && claimed.code) || "taken"));
      // The Space says this server serves its name: without the owner's signed act the directory refuses the server's certificate and address ("that name is not served by this server").
      await d.listServer({ name: label, server });
      await d.chosen.onChosenServer("spaces.name-here", { server, name: label, done: true }, meta, ["name", "done"], DENY);
      return { space: made.space, name: label };
    });
  // For a server named by an earlier build, or one whose listing failed: sign the same act again. Owner only; nothing is claimed or changed on the server.
  d.tool("spaces.server.list", "Tell the names directory that a paired server serves a named space, signed by this computer's identity. Run it once for a server whose space was named without it. Owner only.",
    d.obj({ server: d.str, name: d.str }, ["server", "name"]), async (i) => {
      const label = String(i.name || "").trim().toLowerCase().replace(/\.vyre\.run$/, "");
      if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(label)) throw d.refuse("That is not a space name. Use 2 to 31 letters, digits or hyphens.", "bad_name");
      await d.listServer({ name: label, server: String(i.server || "") });
      return { name: label, listed: true };
    });
}
