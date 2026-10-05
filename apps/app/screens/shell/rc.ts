// What the first release candidate leaves out, in one place (the user's scope ruling, 4 Oct): RC1 is the iPhone app, the web app and the server.
// Publish and Sites are 0.3.1. Claiming a name in a browser is RC2, because the key lives on the phone or Mac. Flip a value to bring it back.
import { Platform } from "react-native";
import { macKeyAvailable } from "../../src/identity/mac-key.ts";

export const RC = {
  sites: false,
  // A build made with EXPO_PUBLIC_VYRE_BROWSER_CLAIM=1 may claim and recover a name in a browser (a walk of the recovery screens needs it). Read as process.env.NAME exactly: Expo inlines only that form.
  browserClaim: process.env.EXPO_PUBLIC_VYRE_BROWSER_CLAIM === "1",
};

/** True when this build is a browser and may not claim a name. The Mac app's window is not a browser: it keeps the identity key in the Mac's Keychain (Host/MacIdentity.swift) and signs through the shell. */
export const claimBlocked = (): boolean => Platform.OS === "web" && !RC.browserClaim && !macKeyAvailable();

/** What the person reads in each hidden path. Specific, and it says where to go. */
export const HIDDEN = {
  claimTitle: "Choose your Vyre name on your phone",
  claimBody: "Your name is made with a key that stays on your iPhone, so it cannot be claimed in a browser. Open Vyre on your iPhone, choose your name there, then come back here and scan from it.",
  claimAction: "Scan from my phone",
  sitesTitle: "Sites arrive in a later release",
  sitesBody: "Publishing a site is not part of this version of Vyre. Nothing you have made is affected.",
  sitesAction: "Back to Now",
};
