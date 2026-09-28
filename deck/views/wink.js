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
// something to try.
//
// team-lead, 2026-09-28: on phone.vyre.run the phone isn't paired yet, so there's no session for
// relay.status to answer to. Checked (core/relay/index.js's `owner()`): an unrecognised caller
// gets a synchronous `denied` thrown at once, not a hang or a prompt - it isn't
// `person_session_required`, so js/api.js never retries it through a sign-in flow either. `attempt`
// below just returns `{ error }` for that, `r.data?.url` is then undefined, and the ternary falls
// straight to DEFAULT_RELAY with no wait and nothing shown to the person.
const DEFAULT_RELAY = "wss://relay.vyre.run";
const WSS_ONLY = /^wss:\/\/[^\s/]+$/;

/**
 * A `?relay=` link parameter, for a self-hosted relay only (relay/client/README.md's own note).
 * Reviewer's LOW, team-lead's ruling (2026-09-28): honoured only in a DEVELOPMENT build (this
 * checkout isn't a stamped, packaged release - core/daemon/build.js's own `stamped` flag,
 * spread into system.info) - a production box ignores it outright, always uses relay.status or
 * the default. Even in dev, wss:// only (never plain ws://, which reviewer's threat model
 * doesn't cover - it would leak the ticket's own locator over an unencrypted connection, not
 * just the timing/whereabouts concern the LOW named).
 *
 * Checks `r.data.stamped === false` explicitly, not `!r.data.stamped` - reviewer's second LOW:
 * a MISSING field would also read as falsy, and core/daemon/build.js only ever set `stamped:
 * true`, never `stamped: false`, so an old or unusual box answering without one would have
 * honoured this by accident. build.js now sets it explicitly in every branch; this still fails
 * closed (treats it as production) on a failed call, a missing field, or anything that isn't the
 * literal `false` a real dev checkout gives.
 */
async function devRelayOverride(/** @type {URLSearchParams} */ query) {
  const override = query.get("relay");
  if (!override || !WSS_ONLY.test(override)) return null;
  const r = await attempt("system.info");
  return r.data?.stamped === false ? override : null;
}

/** @param {any} ctx */
export default async function wink(ctx) {
  const relay = (await devRelayOverride(ctx.query)) || (await defaultRelay());
  if (!ctx.alive()) return;
  const sheet = pairScanSheet({ relay });
  ctx.root.append(sheet.el);
  ctx.cleanup(() => sheet.close());
  sheet.open();
}

async function defaultRelay() {
  const r = await attempt("relay.status");
  return r.data?.url && WSS_ONLY.test(r.data.url) ? r.data.url : DEFAULT_RELAY;
}
