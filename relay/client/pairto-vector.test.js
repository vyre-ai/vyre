// @ts-check
// The bytes an identity signs to own a server (relay/client/finish.js pairToProofMessage), pinned. The Mac shell (Host/SignSummary.swift, Tests/SignSummaryTests.swift) and the Windows shell
// (native-win identity.rs pair_to_summary) read exactly this shape before they sign; they pin the same vector, so a change to the message fails here and there together.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { pairToProofMessage } from "./finish.js";
import { ticketTag } from "./pairwords.js";
import { pairToMessage } from "../../core/wink/pairing.js";

export const VECTOR = {
  box: Buffer.alloc(32, 7).toString("base64url"),
  device: "yfberprk2xq22kob",
  ticket: "AAECAwQFBgcICQoLDA0ODw",
  message: "dnlyZS13aW5rLXBhaXItdG8tdjEKQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Ywp5ZmJlcnByazJ4cTIya29iCjBiNjBjNDA2ZTZlMWE3YzM4YjY5MDBhMw",
};

test("the server ownership proof's bytes are the pinned vector the shells read, and the server checks the same bytes", async () => {
  const m = await pairToProofMessage(VECTOR.box, VECTOR.device, VECTOR.ticket);
  assert.equal(Buffer.from(m).toString("base64url"), VECTOR.message);
  assert.equal(Buffer.from(m).toString(), `vyre-wink-pair-to-v1\n${VECTOR.box}\n${VECTOR.device}\n0b60c406e6e1a7c38b6900a3`);
  assert.deepEqual(Buffer.from(m), pairToMessage(VECTOR.box, VECTOR.device, await ticketTag(VECTOR.ticket)));
});
