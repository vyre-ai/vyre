// The outside things the in-page host's space steps need (host-core.js SpacePorts), bound to this app: the relay client, the setup channel, the pairing the app already does with a server's ticket (src/real/pairing.ts,
// signed by the identity the page holds) and forgetting a pairing. The same pieces src/real/add-server-bind.ts binds for a device that has its identity in the identity store.
import type { SpacePorts } from "./host-core.js";
import { parseWinkCode } from "../api/wink-code";
import { relayUrl } from "../api/relay-url";
import { serverSession, type PairIdentity } from "../real/pairing";

export async function spacePorts(): Promise<SpacePorts> {
  const client = await import("@vyre/relay-client/setup.js");
  const { openChannel, request } = await import("@vyre/relay-client/client.js");
  const { webCrypto } = await import("@vyre/relay-client/webcrypto.js");
  const { connectSetup } = await import("@vyre/relay-client/setupchannel.js");
  const { utf8 } = await import("@vyre/relay-client/bytes.js");
  return {
    client,
    relay: relayUrl(),
    connect: ({ offer, key, secret }) => connectSetup({ openChannel, request, setupHello: client.setupHello, webCrypto, utf8 } as never, { offer, key, secret }),
    // The person pressed Create space, which is the yes to pairing the server that answers their own line, so this pairs beside any server the page already reaches.
    pair: async (qr, ctx, who) => {
      const code = parseWinkCode(qr);
      if (!code.ok) throw new Error("the server gave a ticket this app cannot read");
      const { loadPairings } = await import("../api/relay");
      const before = new Set(Object.keys((await loadPairings()).items));
      const session = serverSession(code, undefined, { ...(ctx && ctx.pageKey ? { pageKey: ctx.pageKey } : {}), addAnother: true, identity: who as PairIdentity });
      await session.ready!();
      await session.confirm();
      // The pairing this call made is the one that was not there before.
      const made = Object.values((await loadPairings()).items).find((p) => !before.has(p.box)) || null;
      return made ? { box: made.box, route: made.route, relay: made.relay, name: String(made.name || "") } : null;
    },
    // The one-space-per-server claim the screens use (real/install.ts makeServerSpace): the paired server names its own space and the directory gets the record, signed by the identity the page holds.
    claim: async (who, { name, route }) => {
      const { makeServerSpace } = await import("../real/install");
      return makeServerSpace(name, name, { key: route.box, route }, who as never);
    },
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
    forget: async (box) => {
      const { removePairingFor } = await import("../api/relay");
      await removePairingFor(box);
      void import("../real/space-servers").then((m) => m.refreshSpaceServers()).catch(() => {});
    },
  };
}
