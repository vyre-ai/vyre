// @ts-check
// Does the home ask a lender's computer to sign its lease request (R031-95 2.2)? The one place the off switch is read.
import { devSwitch } from "../kernel/devbuild.js";
/** Does the home ask a lender's computer to sign its lease request? Always, except where a development build is told VYRE_SIGNED_LEASES_OFF=1; a packaged build ignores the switch (S1). @param {Record<string, string | undefined>} env @param {string} [root] */
export function signedLeasesWanted(env, root) { return !devSwitch(env.VYRE_SIGNED_LEASES_OFF, root); }
