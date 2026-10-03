import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import { tokens } from "../../src/theme/tokens";

const kebab = (s: string) => s.replace(/[A-Z0-9]/g, (c) => "-" + c.toLowerCase());
const roles = Object.keys(tokens.v2.color.dark).map(kebab);
const sizes = ["caption", "body", "read", "title", "page", "display"];
const steps = tokens.v3.spaceSteps.map((n) => `s${n}`);
const corners = [...tokens.v3.corners.applies, "full"];

// Tailwind's own scale is gone (tailwind.config.cjs): only the token names exist, so merge knows them.
const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: sizes }],
      "text-color": [{ text: roles }],
      "bg-color": [{ bg: roles }],
      "border-color": [{ border: roles }],
      rounded: [{ rounded: corners }],
      p: [{ p: steps }], px: [{ px: steps }], py: [{ py: steps }], pt: [{ pt: steps }], pb: [{ pb: steps }], pl: [{ pl: steps }], pr: [{ pr: steps }],
      m: [{ m: steps }], mx: [{ mx: steps }], my: [{ my: steps }], mt: [{ mt: steps }], mb: [{ mb: steps }], ml: [{ ml: steps }], mr: [{ mr: steps }],
      gap: [{ gap: steps }],
    },
  },
});

/** The one way a component joins class names: later classes win over earlier ones. */
export function cn(...inputs: ClassValue[]) {
  return merge(clsx(inputs));
}
