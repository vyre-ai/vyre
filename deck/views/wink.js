// @ts-check
// /pair/scan: scan your avatar to pair your phone (ADR 0037, "Wink"). phone.vyre.run points
// here. Just mounts js/pair-scan.js's sheet and tears the camera down on the way out - the
// actual flow (scan, resolveTicket, confirm, pairOffer, the success dance) lives there.

import { pairScanSheet } from "../js/pair-scan.js";

// The one relay every box registers through (core/relay/index.js's own DEFAULT_RELAY) - not
// per-box, so nothing needs to hand this page a box-specific address. A `?relay=` override is
// for a self-hosted relay only (relay/client/README.md's own note on this); anything other than
// a real wss:// address is ignored, not trusted as-is.
const DEFAULT_RELAY = "wss://relay.vyre.run";

/** @param {any} ctx */
export default async function wink(ctx) {
  const override = ctx.query.get("relay");
  const relay = override && /^wss?:\/\/[^\s/]+$/.test(override) ? override : DEFAULT_RELAY;
  const sheet = pairScanSheet({ relay });
  ctx.root.append(sheet.el);
  ctx.cleanup(() => sheet.close());
  sheet.open();
}
