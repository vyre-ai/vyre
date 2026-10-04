// Types for the platform files: fonts.web.ts (system-ui) and fonts.native.ts
// (the platform's own font); neither bundles a font.
import type { TextStyle } from "react-native";

export type Face = Pick<TextStyle, "fontFamily" | "fontWeight">;
export type Faces = { readonly regular: Face; readonly medium: Face; readonly strong: Face; readonly mono: Face };

/** The system font at 400, 500 and 600, and the platform mono, as a style to spread. */
export const faces: Faces;

/** The faces for the chosen font setting ("system" or "serif"; the older "sans" reads as system): SF on Apple, Roboto on Android, the system font on Windows, Linux and the web. */
export function facesFor(font?: string | null): Faces;
