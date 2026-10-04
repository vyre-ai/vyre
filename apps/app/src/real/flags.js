// @ts-check
// Build switches for what is not in this release. Each is read as `process.env.EXPO_PUBLIC_X` exactly (the only form Expo inlines) and is OFF unless set to "1" at build time.

/** Claiming a name from a browser (a WebCrypto key in IndexedDB) is RC2: off. */
export const BROWSER_CLAIM_ON = process.env.EXPO_PUBLIC_VYRE_BROWSER_CLAIM === "1";
/** Publish (Sites) is 0.3.1: off. */
export const PUBLISH_ON = process.env.EXPO_PUBLIC_VYRE_PUBLISH === "1";

/** May this platform make a new name? A phone or computer app always; a browser only when the build says so. @param {string} os @param {boolean} [on] */
export const claimHere = (os, on = BROWSER_CLAIM_ON) => os !== "web" || on;

export const NO_BROWSER_CLAIM = "Create your name on the phone or computer app, then pair this browser to it.";
