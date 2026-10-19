// The outside things the in-page host's space steps need (host-core.js SpacePorts), bound to this app: the relay client, the setup channel, the pairing the app already does with a server's ticket (src/real/pairing.ts,
// signed by the identity the page holds) and forgetting a pairing. The same pieces src/real/add-server-bind.ts binds for a device that has its identity in the identity store.
import type { SpacePorts } from "./host-core.js";
import { parseWinkCode } from "../api/wink-code";
import { relayUrl } from "../api/relay-url";
import { serverSession, type PairIdentity } from "../real/pairing";
import { trail } from "./trail.js";

export async function spacePorts(): Promise<SpacePorts> {
  const client = await import("@vyre/relay-client/setup.js");
  const { mintPairCode } = await import("@vyre/relay-client/pair-install.js");
  const { openChannel, request } = await import("@vyre/relay-client/client.js");
  const { webCrypto } = await import("@vyre/relay-client/webcrypto.js");
  const { connectSetup } = await import("@vyre/relay-client/setupchannel.js");
  const { utf8 } = await import("@vyre/relay-client/bytes.js");
  return {
    client,
    mintPairCode,
    createSetupKey: client.createSetupKey,
    setupFingerprint: client.setupFingerprint,
    relay: relayUrl(),
    connect: ({ offer, key, secret }) => connectSetup({ openChannel, request, setupHello: client.setupHello, webCrypto, utf8 } as never, { offer, key, secret }),
    // The person pressed Create space, which is the yes to pairing the server that answers their own line, so this pairs beside any server the page already reaches.
    pair: async (qr, ctx, who) => {
      const code = parseWinkCode(qr);
      if (!code.ok) throw new Error("the server gave a ticket this app cannot read");
      const { loadPairings } = await import("../api/relay");
      const before = new Set(Object.keys((await loadPairings()).items));
      const session = serverSession(code, undefined, { ...(ctx && ctx.pageKey ? { pageKey: ctx.pageKey } : {}), addAnother: true, identity: who as PairIdentity });
      const step = (what: string) => trail(`step ${what}`);
      step("pair: waiting for the three words");
      await session.ready!();
      step("pair: words seen, waiting for the server to record this identity");
      await session.confirm();
      step("pair: server recorded this identity");
      // The pairing this call made is the one that was not there before.
      const made = Object.values((await loadPairings()).items).find((p) => !before.has(p.box)) || null;
      return made ? { box: made.box, route: made.route, relay: made.relay, name: String(made.name || "") } : null;
    },
    // The one-space-per-server claim the screens use (real/install.ts makeServerSpace): the paired server names its own space and the directory gets the record, signed by the identity the page holds.
    claim: async (who, { name, route }) => {
      const { makeServerSpace } = await import("../real/install");
      return makeServerSpace(name, name, { key: route.box, route }, who as never);
    },
    // What the claim saw when it told the directory that the server serves the name (undefined: nothing to list). Read once, right after the claim.
    listing: async (space: string) => (await import("../state/space-listing")).takeListing(space),
    call: async (name, input, box) => (await import("../real/box")).tool(name, input, { server: box }),
    // The person's yes to a join link, read and accepted through the team's own server (src/real/join-team.js), as the identity the page holds. The list in the vault is told in the same breath, as the app's own join does.
    join: async (link, who) => {
      const { joinDeps } = await import("../real/team-join");
      const { openInvite } = await import("../real/join-team.js");
      const d = await joinDeps({ id: who.id, name: who.name, eid: who.key.eid, key: who.key });
      if (!d) throw Object.assign(new Error("Choose your Vyre name first."), { code: "no_identity" });
      const inv = await openInvite(d as never, link);
      return { card: inv.card, accept: async () => { const r = await inv.accept(); void import("../real/space-list-app").then((m) => m.recordJoined()).catch(() => {}); return r; }, close: () => inv.close() };
    },
    // Asking to join a Space by its address, as the identity the page holds (src/real/join-team.js askToJoin and askStatus)
    ask: async (address, note, who) => {
      const { joinDeps } = await import("../real/team-join");
      const { askToJoin } = await import("../real/join-team.js");
      const d = await joinDeps({ id: who.id, name: who.name, eid: who.key.eid, key: who.key });
      if (!d) throw Object.assign(new Error("Choose your Vyre name first."), { code: "no_identity" });
      return askToJoin(d as never, address, note);
    },
    askStatus: async (address, who) => {
      const { joinDeps } = await import("../real/team-join");
      const { askStatus } = await import("../real/join-team.js");
      const d = await joinDeps({ id: who.id, name: who.name, eid: who.key.eid, key: who.key });
      if (!d) throw Object.assign(new Error("Choose your Vyre name first."), { code: "no_identity" });
      return askStatus(d as never, address);
    },
    forget: async (box) => {
      const { removePairingFor } = await import("../api/relay");
      await removePairingFor(box);
      void import("../real/space-servers").then((m) => m.refreshSpaceServers()).catch(() => {});
    },
  };
}
