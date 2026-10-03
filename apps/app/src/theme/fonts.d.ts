// Types for the platform files: fonts.web.ts (bundled woff2 under @font-face) and fonts.native.ts
// (the ttf files the expo-font config plugin embeds, app.json).
import type { TextStyle } from "react-native";

export type Face = Pick<TextStyle, "fontFamily" | "fontWeight">;
export type Faces = { readonly regular: Face; readonly medium: Face; readonly strong: Face; readonly mono: Face };

/** Instrument Sans 400 and 600 (500 uses the 600 file) and JetBrains Mono 400 (tokens.font), as a style to spread. */
export const faces: Faces;

/** The faces for the chosen font setting ("sans", "system" or "serif"): the platform's own for "system" (SF on Apple, Roboto on Android, Inter bundled on the web); weights 400, 500 and 600. */
export function facesFor(font?: string | null): Faces;
