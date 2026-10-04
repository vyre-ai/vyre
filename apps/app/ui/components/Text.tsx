/** @jsxImportSource react */
// The one Text. This file opts out of NativeWind's JSX transform (the pragma above) on purpose: a list of thousands of rows mounts a Text per line,
// and resolving class names at runtime cost about 2 ms per row on the web (chat's scroll.hard profile). Here the whole look is a plain style
// object, built once per theme and cached, so a mount is one RN Text with one style. A `className` (rare) goes through TextClass.
import { Platform, Text as RNText, type TextProps } from "react-native";
import { facesFor } from "../../src/theme/fonts";
import { useUiTheme, type UiCtx } from "../theme";
import { TextClass, type TextStyleProps } from "./TextClass";

export type { TextStyleProps };

/** Letter spacing in em (tokens.v2.type.tracking): the big roles pull in a little. */
const TRACKING = { display: -0.025, page: -0.02, title: -0.012, headline: -0.012 } as const;
/** The tone names and the colour roles they read (tokens v2.color). */
const TONE: Record<string, string> = { default: "text", muted: "text-2", label: "label", faint: "faint", accent: "accent", ok: "ok", warn: "warn", err: "err", inverse: "primary-ink" };

const cache = new WeakMap<UiCtx, Map<string, object>>();

function styleFor(ctx: UiCtx, size: string, tone: string, weight: "regular" | "medium" | "strong" | "mono") {
  let m = cache.get(ctx);
  if (!m) cache.set(ctx, (m = new Map()));
  const key = `${size}|${tone}|${weight}`;
  let st = m.get(key);
  if (st) return st;
  const faces = facesFor(ctx.resolved.font);
  const fs = Number.parseFloat(String(ctx.map[`--fs-${size}`]));
  const lh = Number.parseFloat(String(ctx.map[`--lh-${size}`]));
  const em = TRACKING[size as keyof typeof TRACKING];
  // Instrument Sans SemiBold's space is 0.17em (regular's is 0.22em), which glues words together in titles on the web; give it back the difference.
  // (The native builds embed the ttf, which does not have the problem; React Native has no wordSpacing.)
  const gap = Platform.OS === "web" && ctx.resolved.font === "sans" && (weight === "strong" || weight === "medium") ? { wordSpacing: `${Math.max(1, Math.round(fs * 0.06 * 10) / 10)}px` } : null;
  st = { ...faces[weight], color: ctx.color[TONE[tone] ?? "text"], fontSize: fs, lineHeight: lh, ...(em ? { letterSpacing: Math.round(fs * em * 100) / 100 } : null), ...gap };
  m.set(key, st);
  return st;
}

export function Text({ size = "body", tone = "default", mono, strong, medium, className, style, ...rest }: TextProps & TextStyleProps & { className?: string }) {
  const ctx = useUiTheme();
  if (className) return <TextClass size={size} tone={tone} mono={mono} strong={strong} medium={medium} className={className} style={style} {...rest} />;
  const weight = mono ? "mono" : strong ? "strong" : medium ? "medium" : "regular";
  return <RNText {...rest} style={style ? [styleFor(ctx, size as string, tone as string, weight), style] : styleFor(ctx, size as string, tone as string, weight)} />;
}
