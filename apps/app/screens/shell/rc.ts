// What the first release candidate leaves out, in one place (the user's scope ruling, 4 Oct): RC1 is the iPhone app, the web app and the server.
// Publish and Sites are 0.3.1. Claiming a name in a browser is RC2, because the key lives on the phone or Mac. Flip a value to bring it back.
import { Platform } from "react-native";
import { macKeyAvailable } from "../../src/identity/mac-key.ts";
import { passkeyRp } from "../../src/identity/passkey.js";

export const RC = {
  sites: false,
  // Glass is 0.3.1, renamed Screen Share (computer use is under it): its entries are hidden for 0.2.9. Chrome control stays. Flip to bring it back.
  glass: false,
  // A browser claims and recovers a name with a passkey (0.2.9). On unless a build sets EXPO_PUBLIC_VYRE_BROWSER_CLAIM=0 (a test of the phone-only path). Read as process.env.NAME exactly: Expo inlines only that form.
  browserClaim: process.env.EXPO_PUBLIC_VYRE_BROWSER_CLAIM !== "0",
};

/** True when this build is a browser and may not claim a name here: the claim is switched off, or the page is not where a passkey can be made (app.vyre.run in a release build, also http://localhost in a development one). Such a browser pairs as its own device with the typed code, the one way to pair.  The Mac app's window is not a browser: it keeps the identity key in the Mac's Keychain (Host/MacIdentity.swift) and signs through the shell. */
export const claimBlocked = (): boolean =>
  Platform.OS === "web" && !macKeyAvailable() && (!RC.browserClaim || passkeyRp(typeof location !== "undefined" ? location.origin : undefined, { dev: process.env.NODE_ENV !== "production" }) === null);

/** What the person reads in each hidden path. Specific, and it says where to go. */
export const HIDDEN = {
  claimTitle: "Choose your Vyre name on your phone",
  claimBody: "Your name is made with a key that stays on your iPhone, so it cannot be claimed in a browser. Open Vyre on your iPhone, choose your name there, then come back here and scan from it.",
  claimAction: "Scan from my phone",
  sitesTitle: "Sites arrive in a later release",
  sitesBody: "Publishing a site is not part of this version of Vyre. Nothing you have made is affected.",
  sitesAction: "Back to Now",
};
