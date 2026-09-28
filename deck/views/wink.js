// @ts-check
// /pair/scan: scan your avatar to pair your phone (ADR 0037, "Wink"). phone.vyre.run points
// here. Just mounts js/pair-scan.js's sheet and tears the camera down on the way out - the
// actual flow (scan, resolveTicket, confirm, pairOffer, the success dance) lives there.

import { pairScanSheet } from "../js/pair-scan.js";
import { attempt } from "../js/api.js";

// tailnet: this page already knows which box it's talking to (it's the Deck's own box, served
// from here, before the ring is even shown), so the real relay address is a normal tool read,
// relay.status's own `url` field - not a fixed constant. Falls back to the one relay every box
// registers through by default (core/relay/index.js's own DEFAULT_RELAY) if that call fails for
// any reason (a stale cache, a box that hasn't enabled the relay) so the sheet still has
// something to try. A `?relay=` override is for a self-hosted relay only (relay/client/
// README.md's own note); anything other than a real wss:// address is ignored, not trusted as-is.
//
// team-lead, 2026-09-28: on phone.vyre.run the phone isn't paired yet, so there's no session for
// relay.status to answer to. Checked (core/relay/index.js's `owner()`): an unrecognised caller
// gets a synchronous `denied` thrown at once, not a hang or a prompt - it isn't
// `person_session_required`, so js/api.js never retries it through a sign-in flow either. `attempt`
// below just returns `{ error }` for that, `r.data?.url` is then undefined, and the ternary falls
// straight to DEFAULT_RELAY with no wait and nothing shown to the person.
const DEFAULT_RELAY = "wss://relay.vyre.run";

/** @param {any} ctx */
export default async function wink(ctx) {
  const override = ctx.query.get("relay");
  let relay = override && /^wss?:\/\/[^\s/]+$/.test(override) ? override : null;
  if (!relay) {
    const r = await attempt("relay.status");
    relay = r.data?.url && /^wss?:\/\/[^\s/]+$/.test(r.data.url) ? r.data.url : DEFAULT_RELAY;
  }
  if (!ctx.alive()) return;
  const sheet = pairScanSheet({ relay });
  ctx.root.append(sheet.el);
  ctx.cleanup(() => sheet.close());
  sheet.open();
}
