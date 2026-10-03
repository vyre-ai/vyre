import { Text as RNText, type TextProps } from "react-native";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";
import { facesFor } from "../../src/theme/fonts";
import { useUiTheme } from "../theme";

const text = cva("", {
  variants: {
    size: { caption: "text-caption", body: "text-body", read: "text-read", title: "text-title", page: "text-page", display: "text-display" },
    tone: { default: "text-text", muted: "text-text-2", label: "text-label", faint: "text-faint", accent: "text-accent", ok: "text-ok", warn: "text-warn", err: "text-err", inverse: "text-primary-ink" },
  },
  defaultVariants: { size: "body", tone: "default" },
});

export type TextStyleProps = VariantProps<typeof text> & { strong?: boolean; mono?: boolean };

/** The one Text: type roles and tones are token names. Weight is 400 or 600, set as the face. The face follows the font setting: Instrument Sans by default, the platform's own for "system". */
export function Text({ size, tone, mono, strong, className, style, ...rest }: TextProps & TextStyleProps & { className?: string }) {
  const { resolved } = useUiTheme();
  const faces = facesFor(resolved.font);
  const face = mono ? faces.mono : strong ? faces.strong : faces.regular;
  return <RNText {...rest} style={[face, style]} className={cn(text({ size, tone }), className)} />;
}
