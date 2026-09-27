// Types for the platform files: fonts.web.ts (bundled woff2 under @font-face) and fonts.native.ts
// (the ttf files the expo-font config plugin embeds, app.json).
import type { TextStyle } from "react-native";

export type Face = Pick<TextStyle, "fontFamily" | "fontWeight">;

/** Instrument Sans 400 and 600 and JetBrains Mono 400 (tokens.font), as a style to spread. */
export const faces: { readonly regular: Face; readonly strong: Face; readonly mono: Face };
