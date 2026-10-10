// @ts-check
// Fixtures for contracts/one-yes.md (team/contracts/one-yes.md). A consumer (operations: Comms, Documents; trust: Publish; chat: the approval card in a chat) builds against these while link keeps the floor. Every
// value is checked against the real registry, the real queue and lib/one-yes.js by test/contracts/one-yes.test.js, so a fixture that drifts from the producer fails there.
export { shapeDiff } from "./operator-cards.fixtures.js";

export const moments = ["pair", "vault", "outward"];
export const reasons = ["no_proof", "expired", "replayed", "wrong_request", "software_key", "unknown_key"];

/** What an agent, a model, the harness, a module acting for one, or a guest gets back from a tool marked `outward: true`: nothing ran, and the person has a card. */
export const heldError = {
  code: "held_for_approval", approval: "ap_01a12328-a4fa-4c50-9e95-13ea33242a1d", line: "An assistant (agent:kit) wants to run mail.send (to: a@example.com, subject: x, body: y)", group: "gp_01a12328-a4fa-4cd7-966f-1ebd816e60cd",
  message: "mail.send acts as you outside, so it waits for your yes on your phone (approval ap_01a12328-a4fa-4c50-9e95-13ea33242a1d). Nothing ran. After you approve, call it again with the same input and approval: ap_01a12328-a4fa-4c50-9e95-13ea33242a1d",
};
/** The retry with a card that was not approved, was spent, was for another call, or is not this asker's. */
export const refusedError = { code: "approval_refused", message: "that approval does not cover this call (no_proof); ask again" };

/** A manifest entry of a tool that is outward and files another outward tool as part of the same act. */
export const manifestEntry = { name: "comms.send", outward: true, covers: ["mail.send"], effect: "write", reach: "anyone" };

/** The shape of `yes()` for each way it ends. */
export const yesResults = {
  ok: { ok: true, strength: "real" },
  refused: { ok: false, reason: "software_key" },
};

/** The mark a registry puts on a call whose card it just redeemed (a Symbol-keyed property of the call's meta, never JSON). `via` lists the modules the mark was passed to by `covers`. */
export const coveredMark = { card: "ap_01a12328-a4fa-4c50-9e95-13ea33242a1d", tool: "comms.send", input_sha256: "213e4524678984dafc1ac37f5d04e070", asker: "mcp:agent:kit", via: ["mail"] };

export const limits = { cardLifeMs: 120_000, askMs: 300_000, reuseMs: 300_000, coversMax: 4 };
