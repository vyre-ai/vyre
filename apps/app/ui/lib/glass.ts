import type { ViewStyle } from "react-native";

/** `#RRGGBB` at an opacity, as rgba (a theme colour with a see-through tint). */
export function tint(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/**
 * Glass: the page colour at 75 percent with a 24 blur behind it where the platform draws one (the web and iOS-like engines through backdropFilter). Where a
 * platform has no backdrop blur the tint alone shows, which is why it is 75 percent and not less.
 */
export function glass(bg: string, alpha = 0.75): ViewStyle {
  return { backgroundColor: tint(bg, alpha), backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" } as ViewStyle;
}
