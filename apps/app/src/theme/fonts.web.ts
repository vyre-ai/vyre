// The web build: the platform's own font (system-ui: SF on Apple, Segoe UI on Windows, Roboto elsewhere).
// Nothing is bundled and nothing downloads (the font ruling, 4 Oct 2026). Instrument Sans stays on the wordmark and the web pages.
import type { Face, Faces } from "./fonts";

const system = `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
const mono = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
const serif = `"Iowan Old Style", "Palatino Linotype", Georgia, serif`;
const face = (fontFamily: string, fontWeight: Face["fontWeight"]): Face => ({ fontFamily, fontWeight });

const SYSTEM: Faces = { regular: face(system, "400"), medium: face(system, "500"), strong: face(system, "600"), mono: face(mono, "400") };
const SERIF: Faces = { regular: face(serif, "400"), medium: face(serif, "600"), strong: face(serif, "700"), mono: SYSTEM.mono };

export const faces: Faces = SYSTEM;

/** The faces for the font chosen: "serif" is the serif stack; anything else (including the older "sans") is the system font. */
export function facesFor(font?: string | null): Faces {
  return font === "serif" ? SERIF : SYSTEM;
}
