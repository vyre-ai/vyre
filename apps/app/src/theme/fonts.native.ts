// The native builds: the expo-font config plugin (app.json) embeds the ttf files, so each face is
// there by its PostScript name before the first frame, with nothing to load. One file per weight:
// no fontWeight, which Android would fake on top of the SemiBold file.
import type { Face } from "./fonts";

export const faces: { readonly regular: Face; readonly strong: Face; readonly mono: Face } = {
  regular: { fontFamily: "InstrumentSans-Regular" },
  strong: { fontFamily: "InstrumentSans-SemiBold" },
  mono: { fontFamily: "JetBrainsMono-Regular" },
};
