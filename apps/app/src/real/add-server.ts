// The add-a-server piece bound to this app (add-server.js has the rules and the words): the relay client, the setup channel, this device's identity and the pairing the app already does with a server's code.
// A device that cannot make the non-extractable key the install line needs (a phone's JavaScript engine has no WebCrypto) stops with the plain words; the person adds the server from a computer.

import { createAddServer, type AddServerState } from "./add-server.js";
import { parseWinkCode } from "../api/wink-code";
import { relayUrl } from "../api/relay-url";
import { loadIdentity } from "../identity/store";
import { serverSession } from "./pairing";

export type { AddServerState };

/** A fresh run. `onChange` hears every change of the state. */
export async function startAddServer(onChange: (s: AddServerState) => void) {
  const client = await import("@vyre/relay-client/setup.js");
  const { openChannel, request } = await import("@vyre/relay-client/client.js");
  const { webCrypto } = await import("@vyre/relay-client/webcrypto.js");
  const { connectSetup } = await import("@vyre/relay-client/setupchannel.js");
  const { utf8 } = await import("@vyre/relay-client/bytes.js");
  return createAddServer({
    client: client as never,
    relay: relayUrl(),
    identity: async () => {
      const me = await loadIdentity();
      if (!me) throw new Error("no identity on this device");
      return { id: me.id };
    },
    connect: ({ offer, key, secret }) => connectSetup({ openChannel, request, setupHello: client.setupHello, webCrypto, utf8 }, { offer, key, secret }),
    // The same pairing a scanned code starts: the identity's signature is the proof at the server, so nobody answers a question there.
    pair: async (qr: string) => {
      const code = parseWinkCode(qr);
      if (!code.ok) throw new Error("the server gave a ticket this app cannot read");
      const session = serverSession(code);
      await session.ready!();
      await session.confirm();
    },
    onChange: onChange as never,
  });
}
