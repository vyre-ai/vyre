// The web build: the fonts are bundled with the app (woff2, content-hashed, precached) and declared
// once with @font-face, by weight, so the page loads no font from another host (the Deck's CSP).
// Inter 400, 500 and 600, Instrument Sans 400 and 600 and JetBrains Mono 400, from each font's own source, OFL
// (assets/fonts/*/OFL.txt). font-display swap: text paints at once in the fallback, then swaps.
import { Asset } from "expo-asset";
import { tokens } from "./tokens";
import type { Face, Faces } from "./fonts";

const SANS = tokens.font.sans;
const MONO = tokens.font.mono;
const { regular, strong } = tokens.font.weight;

const FACES: [family: string, weight: string, file: number][] = [
  // Inter is the web's platform font (the "system" setting, and the default): bundled so the page never shows whatever the machine has. OFL, assets/fonts/inter/OFL.txt.
  ["Inter", "400", require("../../assets/fonts/inter/Inter-400.woff2")],
  ["Inter", "500", require("../../assets/fonts/inter/Inter-500.woff2")],
  ["Inter", "600", require("../../assets/fonts/inter/Inter-600.woff2")],
  [SANS, regular, require("../../assets/fonts/instrument-sans/InstrumentSans-Regular.woff2")],
  [SANS, strong, require("../../assets/fonts/instrument-sans/InstrumentSans-SemiBold.woff2")],
  [MONO, regular, require("../../assets/fonts/jetbrains-mono/JetBrainsMono-Regular.woff2")],
];

if (typeof document !== "undefined" && !document.getElementById("vy-fonts")) {
  const css = document.createElement("style");
  css.id = "vy-fonts";
  css.textContent = FACES.map(
    ([family, weight, file]) =>
      `@font-face{font-family:"${family}";font-weight:${weight};font-style:normal;font-display:swap;src:url("${Asset.fromModule(file).uri}") format("woff2")}`,
  ).join("\n");
  document.head.appendChild(css);
}

const sans = `"${SANS}", system-ui, -apple-system, "Segoe UI", sans-serif`;

export const faces: Faces = {
  regular: { fontFamily: sans, fontWeight: regular },
  medium: { fontFamily: sans, fontWeight: strong },
  strong: { fontFamily: sans, fontWeight: strong },
  mono: { fontFamily: `"${MONO}", ui-monospace, Menlo, monospace`, fontWeight: regular },
};

const system = `Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
const serifFace = (w: string) => ({ fontFamily: `"Iowan Old Style", "Palatino Linotype", Georgia, serif`, fontWeight: w } as Face);
const serif = `"Iowan Old Style", "Palatino Linotype", Georgia, serif`;
const SYSTEM: Faces = { regular: { fontFamily: system, fontWeight: regular }, medium: { fontFamily: system, fontWeight: "500" }, strong: { fontFamily: system, fontWeight: strong }, mono: faces.mono };
const SERIF: Faces = { regular: { fontFamily: serif, fontWeight: regular }, medium: serifFace("600"), strong: { fontFamily: serif, fontWeight: "700" }, mono: faces.mono };

/** The faces for the font chosen: "sans" is the bundled Instrument Sans; "system" is the bundled Inter; "serif" is the serif stack. */
export function facesFor(font?: string | null): Faces {
  return font === "system" ? SYSTEM : font === "serif" ? SERIF : faces;
}
