// The setup page's entry: the real relay client from ./relay (build-site.sh copies relay/client here), the
// flow, and the screen. No storage, no cookies, nothing in the URL: the code lives in this tab's memory.
import * as client from "./relay/setup.js";
import { createFlow } from "./flow.js";
import { render } from "./ui.js";

const RELAY = "wss://relay.vyre.run";
const root = document.getElementById("setup");

const actions = {
  begin: () => flow.begin(),
  async copy(text, button) {
    try { await navigator.clipboard.writeText(text); button.textContent = "Copied"; }
    catch { button.textContent = "Select the line and copy it"; }
    setTimeout(() => { button.textContent = "Copy"; }, 2500);
  },
};
const flow = createFlow({ client, relay: RELAY, onChange: s => render(s, { doc: document, root, actions }) });
render(flow.state, { doc: document, root, actions });
addEventListener("pagehide", () => flow.stop());
