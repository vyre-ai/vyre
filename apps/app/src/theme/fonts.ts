import { Platform } from "react-native";

/** The mono family (tokens.font.mono), with the platform's own monospace behind it until the font is bundled. */
export const MONO: string =
  Platform.OS === "web" ? "'JetBrains Mono', ui-monospace, Menlo, monospace" : Platform.OS === "ios" ? "Menlo" : "monospace";
