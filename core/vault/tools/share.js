// @ts-check
// Tools for people and the recovery kit (ADR 0006, decision 5). The pass tools stay in index.js.
//
// Who may call what follows the rule the rest of the vault uses: reading who you share with is
// open to everyone (a card and a fingerprint are public), pinning a card from Claude waits for a
// person, and saying "I compared fingerprints" or printing a kit needs a person who is present.

import { serveKit } from "../kit.js";
import { isAsker } from "../asker.js";

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });

/**
 * @param {{ ctx: any, vault: import("../vault.js").Vault, tool?: any,
 *   secretKey?: () => Promise<string|null|undefined>, ttlMs?: number }} o
 *   `secretKey` is injected until the account key hierarchy lands; after that the Vault's own
 *   `secretKey()` is used when present.
 */
export function register({ ctx, vault, secretKey, ttlMs }) {
  const share = vault.share;
  const def = (name, d) => ctx.tool(name, d);

  def("vault.people", {
    callers: ["cli", "local", "deck", "capsule", "tailnet", "device", "module"],
    description: "The people this Vyre shares with: name, fingerprint, whether you verified it, and whether a changed key blocks new passes. Never a secret.",
    input: obj({}),
    run: () => share.people(),
  });

  def("vault.person.add", {
    description: "Pin a person's Vyre card (trust on first use). A changed key blocks new passes until verified. From Claude it waits for a person.",
    input: obj({ card: str, name: str }, ["card"]),
    callers: ["cli", "local", "mcp"],
    // From Claude the card waits as pending for a person, so there is nothing to prove yet.
    presence: { summary: async ({ name, card }) => `Trust the card for ${name || personName(card)}`, skip: ({ caller }) => isAsker(caller) },
    run: (input, { caller }) => share.addPerson(input, caller),
  });

  def("vault.people.verify", {
    description: "Say you compared fingerprints with a person out of band and they match. The fingerprint is checked against the card on file.",
    input: obj({ name: str, fingerprint: str }, ["name", "fingerprint"]),
    callers: ["cli", "local"],
    presence: { summary: async ({ name }) => `Mark ${name}'s card as verified` },
    run: (input, { caller }) => share.verifyPerson(input, caller),
  });

  def("vault.fingerprint", {
    description: "This Vyre's fingerprint; with `with`, that person's fingerprint and the four safety words you should both see.",
    input: obj({ with: str }),
    run: input => share.fingerprintWith(input),
  });

  // One kit page at a time: asking again ends the one before.
  /** @type {null | { close: () => Promise<void> }} */
  let live = null;
  const getKey = secretKey || (typeof /** @type {any} */ (vault).secretKey === "function" ? () => /** @type {any} */ (vault).secretKey() : null);

  def("vault.kit", {
    description: "Print a recovery kit: a one-time page on this machine, gone after one load or ten minutes, with the account id, Secret Key, fingerprint, box address and a QR code. Never the password.",
    input: obj({}),
    callers: ["cli", "local"],
    presence: { summary: async () => "Print a recovery kit" },
    run: async (_input, { caller }) => {
      // The Vault's secretKey() throws when this device has none; either way there is nothing to print.
      const sk = getKey ? await Promise.resolve().then(getKey).catch(() => null) : null;
      if (!sk) throw new Error("this vault has no Secret Key yet; it comes with the account password (ADR 0006), so there is nothing to print");
      if (live) await live.close();
      const k = await serveKit({
        secretKey: /** @type {any} */ (getKey),
        info: async () => ({ name: vault.name, acct: await share.accountId(), fp: await share.myFingerprint(), relay: vault.relayUrl }),
        ttlMs,
        onServed: () => {
          vault.audit("kit", null, caller, true, "printed");
          vault.emit("vault.kit-printed", { by: String(caller) });
        },
        onClosed: why => { if (why === "expired") vault.audit("kit", null, caller, true, "expired unopened"); },
      });
      live = k;
      k.closed.then(() => { if (live === k) live = null; });
      vault.audit("kit", null, caller, true, "one-time page opened");
      return { url: k.url, expires: k.expires };
    },
  });

  return { async stop() { if (live) await live.close(); } };
}

/** The name on a card, for a presence summary; never throws. */
function personName(card) {
  try {
    const s = String(card).trim();
    const body = JSON.parse(Buffer.from(s.slice(s.indexOf(":", 10) + 1), "base64url").toString("utf8"));
    return typeof body.name === "string" ? body.name : "someone";
  } catch { return "someone"; }
}
