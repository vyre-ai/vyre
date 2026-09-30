// The setup page's entry: the real relay client from ./relay (build-site.sh copies relay/client here), the
// flow, and the screen. No storage, no cookies, nothing in the URL: the code lives in this tab's memory.
import * as client from "./relay/setup.js";
import { openChannel, request } from "./relay/client.js";
import { webCrypto } from "./relay/webcrypto.js";
import { utf8 } from "./relay/bytes.js";
import { connectSetup } from "./box.js";
import { createFlow } from "./flow.js";
import { render } from "./ui.js";
import { ticketRingSvg } from "./deck/js/phone-code.js";

const RELAY = "wss://relay.vyre.run";
const root = document.getElementById("setup");

const actions = {
  begin: () => flow.begin(),
  setName: text => flow.setName(text),
  claim: () => flow.claim(),
  confirmWords: () => flow.confirmWords(),
  denyWords: () => flow.denyWords(),
  markSaved: () => flow.markSaved(),
  continueToAi: () => flow.continueToAi(),
  continueToTailscale: () => flow.continueToTailscale(),
  connectTailscale: () => flow.connectTailscale(),
  startAi: p => flow.startAi(p),
  submitAiCode: (id, code) => flow.submitAiCode(id, code),
  continueToDevices: () => flow.continueToDevices(),
  addPhone: () => flow.addPhone(),
  // The ring is drawn from the ticket as SVG shapes only; the ticket is never put in the page as text.
  drawRing(slot) {
    const t = flow.currentTicket();
    if (!t) return;
    const svg = new DOMParser().parseFromString(ticketRingSvg(t, { size: 280 }), "image/svg+xml").documentElement;
    slot.replaceChildren(document.importNode(svg, true));
  },
  async copy(text, button) {
    try { await navigator.clipboard.writeText(text); button.textContent = "Copied"; }
    catch { button.textContent = "Select the text and copy it"; }
    setTimeout(() => { button.textContent = "Copy"; }, 2500);
  },
};
const connect = ({ offer, key, secret }) => connectSetup({ openChannel, request, setupHello: client.setupHello, webCrypto, utf8 }, { offer, key, secret });
// The recovery code is shown once and only here: closing or reloading before "I saved it" asks first.
let unsaved = false;
addEventListener("beforeunload", e => { if (unsaved) { e.preventDefault(); e.returnValue = ""; } });
// The hosts a provider's sign-in page may be on (lib/providers/signin-hosts.json, copied in by build-site.sh). No list yet: any plain https address.
let signinHosts = null;
try { const r = await fetch("/setup/signin-hosts.json", { cache: "no-store" }); if (r.ok) { const j = await r.json(); if (Array.isArray(j)) signinHosts = j.map(String); else if (j && Array.isArray(j.hosts)) signinHosts = j.hosts.map(String); } } catch { /* none */ }
const flow = createFlow({ client, relay: RELAY, connect, signinHosts, onChange: s => { unsaved = Boolean(s.named && s.named.recoveryCode && !s.named.saved); render(s, { doc: document, root, actions }); } });
render(flow.state, { doc: document, root, actions });
addEventListener("pagehide", () => flow.stop());
