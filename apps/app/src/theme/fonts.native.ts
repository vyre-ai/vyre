// The native builds: the platform's own font, nothing embedded (the font ruling, 4 Oct 2026).
// San Francisco on Apple, Roboto on Android. Android gets one family per weight: a fontWeight on the system family is synthesised on some builds.
import { Platform } from "react-native";
import type { Faces } from "./fonts";

const ios = Platform.OS === "ios";
const mono = ios ? { fontFamily: "Menlo" } : { fontFamily: "monospace" };

const SYSTEM: Faces = ios
  ? { regular: { fontFamily: "System", fontWeight: "400" }, medium: { fontFamily: "System", fontWeight: "500" }, strong: { fontFamily: "System", fontWeight: "600" }, mono }
  : { regular: { fontFamily: "sans-serif" }, medium: { fontFamily: "sans-serif-medium" }, strong: { fontFamily: "sans-serif-medium" }, mono };
const SERIF: Faces = ios
  ? { regular: { fontFamily: "Georgia" }, medium: { fontFamily: "Georgia" }, strong: { fontFamily: "Georgia-Bold" }, mono }
  : { regular: { fontFamily: "serif" }, medium: { fontFamily: "serif" }, strong: { fontFamily: "serif", fontWeight: "700" }, mono };

export const faces: Faces = SYSTEM;

/** The faces for the font chosen: "serif" is the serif; anything else (including the older "sans") is the platform's own. */
export function facesFor(font?: string | null): Faces {
  return font === "serif" ? SERIF : SYSTEM;
}
