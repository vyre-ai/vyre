// The native builds: the expo-font config plugin (app.json) embeds the ttf files, so each face is
// there by its PostScript name before the first frame, with nothing to load. One file per weight:
// no fontWeight, which Android would fake on top of the SemiBold file.
import { Platform } from "react-native";
import type { Face, Faces } from "./fonts";

export const faces: Faces = {
  regular: { fontFamily: "InstrumentSans-Regular" },
  medium: { fontFamily: "InstrumentSans-SemiBold" },
  strong: { fontFamily: "InstrumentSans-SemiBold" },
  mono: { fontFamily: "JetBrainsMono-Regular" },
};

const SYSTEM: Faces = Platform.OS === "ios"
  ? { regular: { fontFamily: "System", fontWeight: "400" }, medium: { fontFamily: "System", fontWeight: "500" }, strong: { fontFamily: "System", fontWeight: "600" }, mono: faces.mono }
  // Android: Roboto by its system names, one family per weight (a fontWeight on the system family is synthesised on some builds).
  : { regular: { fontFamily: "sans-serif" }, medium: { fontFamily: "sans-serif-medium" }, strong: { fontFamily: "sans-serif-medium" }, mono: faces.mono };
const SERIF: Faces = Platform.OS === "ios"
  ? { regular: { fontFamily: "Georgia" }, medium: { fontFamily: "Georgia" }, strong: { fontFamily: "Georgia-Bold" }, mono: faces.mono }
  : { regular: { fontFamily: "serif" }, medium: { fontFamily: "serif" }, strong: { fontFamily: "serif", fontWeight: "700" }, mono: faces.mono };

/** The faces for the font the space or person chose: "sans" is the bundled brand font (Instrument Sans); "system" is the platform's own (SF on Apple, Roboto on Android). */
export function facesFor(font?: string | null): Faces {
  return font === "system" ? SYSTEM : font === "serif" ? SERIF : faces;
}
