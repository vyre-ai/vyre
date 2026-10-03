import { Platform, Text as RNText, type TextProps } from "react-native";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";
import { facesFor } from "../../src/theme/fonts";
import { useUiTheme } from "../theme";

const text = cva("", {
  variants: {
    size: { caption: "text-caption", secondary: "text-secondary", body: "text-body", headline: "text-headline", read: "text-read", title: "text-title", page: "text-page", display: "text-display" },
    tone: { default: "text-text", muted: "text-text-2", label: "text-label", faint: "text-faint", accent: "text-accent", ok: "text-ok", warn: "text-warn", err: "text-err", inverse: "text-primary-ink" },
  },
  defaultVariants: { size: "body", tone: "default" },
});

export type TextStyleProps = VariantProps<typeof text> & { strong?: boolean; medium?: boolean; mono?: boolean };

/** Letter spacing in em (tokens.v2.type.tracking): the big roles pull in a little. */
const TRACKING = { display: -0.025, page: -0.02, title: -0.012, headline: -0.012 } as const;

/**
 * The one Text: type roles (caption, secondary, body, headline, read, title, page, display) and tones are token names; the sizes follow the platform
 * (ui-system.md section 2). Weights are 400, `medium` 500 (buttons) and `strong` 600 (titles), set as the face. The face follows the font setting:
 * the platform's own by default (SF, Roboto, bundled Inter on the web), Instrument Sans or the serif when a space or person chooses it.
 */
export function Text({ size, tone, mono, strong, medium, className, style, ...rest }: TextProps & TextStyleProps & { className?: string }) {
  const { resolved, map } = useUiTheme();
  const faces = facesFor(resolved.font);
  const face = mono ? faces.mono : strong ? faces.strong : medium ? faces.medium : faces.regular;
  const em = size ? TRACKING[size as keyof typeof TRACKING] : undefined;
  const fs = em ? Number.parseFloat(String(map[`--fs-${size}`])) : 0;
  // Instrument Sans SemiBold's space is 0.17em (regular's is 0.22em), which glues words together in titles on the web; give it back the difference.
  // (The native builds embed the ttf, which does not have the problem; React Native has no wordSpacing.)
  const gap = Platform.OS === "web" && resolved.font === "sans" && !mono && (strong || medium) ? { wordSpacing: `${Math.max(1, Math.round(Number.parseFloat(String(map[`--fs-${size ?? "body"}`])) * 0.06 * 10) / 10)}px` } : null;
  return <RNText {...rest} style={[face, gap as object | null, em ? { letterSpacing: Math.round(fs * em * 100) / 100 } : null, style]} className={cn(text({ size, tone }), className)} />;
}
