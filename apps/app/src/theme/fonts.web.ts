// The web build: the fonts are bundled with the app (woff2, content-hashed, precached) and declared
// once with @font-face, by weight, so the page loads no font from another host (the Deck's CSP).
// Instrument Sans 400 and 600 and JetBrains Mono 400, from each font's own GitHub source, OFL
// (assets/fonts/*/OFL.txt). font-display swap: text paints at once in the fallback, then swaps.
import { Asset } from "expo-asset";
import { tokens } from "./tokens";
import type { Face } from "./fonts";

const SANS = tokens.font.sans;
const MONO = tokens.font.mono;
const { regular, strong } = tokens.font.weight;

const FACES: [family: string, weight: string, file: number][] = [
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

export const faces: { readonly regular: Face; readonly strong: Face; readonly mono: Face } = {
  regular: { fontFamily: sans, fontWeight: regular },
  strong: { fontFamily: sans, fontWeight: strong },
  mono: { fontFamily: `"${MONO}", ui-monospace, Menlo, monospace`, fontWeight: regular },
};
