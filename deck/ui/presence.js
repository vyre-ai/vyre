// @ts-check
// deck/ui/presence: the person's fresh presence, as the kernel asks for it. The kernel's two human-only acts, ask.decide (approve a held send) and seal.reveal (show a
// sealed value), take a PresenceProof: a signature from a biometric-gated hardware key over THIS payload (kernel/contracts/chain.d.ts). A click is not one.
// In the preview there is no key, so a sheet with one button stands in for Face ID and builds a proof of the right shape from it; nothing is signed and the mock store
// only checks the shape. The real signer (the phone's biometric, WebAuthn, the Secure Enclave) replaces `simulatedProof` and nothing else: every screen asks through
// askProof() and askReveal(), and every call to the store passes what they return.
import { h, add } from "../js/dom.js";
import { button, openSheet } from "./components/index.js";
import { signerWords, simulatedProof } from "./kernel-view.js";

/** @typedef {import("./contracts.js").PresenceProof} PresenceProof */

export { signerWords, simulatedProof };

/**
 * The Face ID confirm sheet for an approval. Resolves with the proof, or null when it is closed without confirming.
 * @param {{ title: string, what: string, confirm?: string, decision?: string, payload_hash?: string }} o
 * @returns {Promise<PresenceProof|null>}
 */
export function askProof(o) {
  return new Promise(resolve => {
    let settled = false;
    const finish = (/** @type {PresenceProof|null} */ v) => { if (!settled) { settled = true; resolve(v); } };
    openSheet({
      title: o.title, onClose: () => finish(null),
      build(body, close, { actions }) {
        body.append(h("p", { class: "un-sheet-p" }, o.what), h("p", { class: "ui-hint" }, "Face ID confirms it is you. In this preview a button stands in for it, and nothing is sent."));
        actions.append(button({ label: "Cancel", kind: "ghost", onclick: () => close() }),
          button({ label: o.confirm || "Confirm with Face ID", kind: "primary", icon: "shield", onclick: () => { finish(simulatedProof({ decision: o.decision || o.title, payload_hash: o.payload_hash })); close(); } }));
      },
    });
  });
}

/**
 * The Face ID ask before a Reveal: a sheet with one button. Resolves with the proof, or null when the person closes it.
 * @param {{ label: string, decision?: string }} o @returns {Promise<PresenceProof|null>}
 */
export function askReveal(o) {
  return new Promise(resolve => {
    let done = false;
    const finish = (/** @type {PresenceProof|null} */ v) => { if (!done) { done = true; resolve(v); } };
    openSheet({ title: `Reveal ${o.label}`, onClose: () => finish(null), build: (body, close, parts) => {
      add(body, h("p", { class: "uv-sheet-p" }, "Confirm with Face ID. It shows for 30 seconds, then hides again."));
      add(parts.actions, button({ label: "Use Face ID", kind: "primary", icon: "key", onclick: () => { finish(simulatedProof({ decision: o.decision || `reveal:${o.label}` })); close(); } }),
        button({ label: "Cancel", kind: "ghost", onclick: () => close() }));
    } });
  });
}
