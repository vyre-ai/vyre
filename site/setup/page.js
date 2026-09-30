// The setup page's entry: the real relay client from ./relay (build-site.sh copies relay/client here), the
// flow, and the screen. No storage, no cookies, nothing in the URL: the code lives in this tab's memory.
import * as client from "./relay/setup.js";
import { openChannel, request } from "./relay/client.js";
import { webCrypto } from "./relay/webcrypto.js";
import { utf8 } from "./relay/bytes.js";
import { connectSetup } from "./box.js";
import { createFlow } from "./flow.js";
import { render } from "./ui.js";

const RELAY = "wss://relay.vyre.run";
const root = document.getElementById("setup");

const actions = {
  begin: () => flow.begin(),
  setName: text => flow.setName(text),
  claim: () => flow.claim(),
  async copy(text, button) {
    try { await navigator.clipboard.writeText(text); button.textContent = "Copied"; }
    catch { button.textContent = "Select the text and copy it"; }
    setTimeout(() => { button.textContent = "Copy"; }, 2500);
  },
};
const connect = ({ offer, key, secret }) => connectSetup({ openChannel, request, setupHello: client.setupHello, webCrypto, utf8 }, { offer, key, secret });
const flow = createFlow({ client, relay: RELAY, connect, onChange: s => render(s, { doc: document, root, actions }) });
render(flow.state, { doc: document, root, actions });
addEventListener("pagehide", () => flow.stop());
