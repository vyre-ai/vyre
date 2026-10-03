// The look comes from lib/theme/tokens.json (v2 and v3), the one token source, and from nothing else.
// Every colour, size, radius and space is a CSS custom property the ThemeProvider in ui/theme.tsx writes
// (so a space's accent, density and corners, and a person's theme, restyle every component with no code of its own).
// Here the names are mapped to those properties, so a component says `bg-surface1` or `rounded-card` and never a value.
const tokens = require("../../lib/theme/tokens.json");

const v2 = tokens.v2;
const roles = Object.keys(v2.color.dark);
const kebab = (s) => s.replace(/[A-Z0-9]/g, (c) => "-" + c.toLowerCase());
const colors = Object.fromEntries(roles.map((r) => [kebab(r), `var(--${kebab(r)})`]));
const space = Object.fromEntries(tokens.v3.spaceSteps.map((n) => [`s${n}`, `var(--s-${n})`]));
const radii = Object.fromEntries([...tokens.v3.corners.applies, "full"].map((r) => [r, `var(--r-${r})`]));
const sizes = ["caption", "secondary", "body", "headline", "read", "title", "page", "display"];

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./ui/**/*.{ts,tsx}", "./screens/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    // Nothing from Tailwind's default scale: only the token names exist.
    colors: { transparent: "transparent", ...colors },
    spacing: { 0: "0px", px: "1px", ...space },
    borderRadius: { none: "0px", ...radii },
    fontSize: Object.fromEntries(sizes.map((s) => [s, ["var(--fs-" + s + ")", { lineHeight: "var(--lh-" + s + ")" }]])),
    extend: {
      height: { control: "var(--control)", "control-sm": "var(--control-sm)", row: "var(--row-h)", touch: "var(--touch)" },
      minHeight: { control: "var(--control)", "control-sm": "var(--control-sm)", row: "var(--row-h)", touch: "var(--touch)", cell: "calc(var(--row-h) * 2)" },
      width: { side: "var(--side)", rail: "calc(var(--s-12) * 5)", ring: "calc(var(--s-12) * 4)", control: "var(--control)", "control-sm": "var(--control-sm)", touch: "var(--touch)" },
      minWidth: { menu: "calc(var(--s-12) * 4)", pane: "calc(var(--s-12) * 7 + var(--s-1))" },
      maxWidth: { page: "var(--page-max)", read: "var(--read-max)" },
    },
  },
};
