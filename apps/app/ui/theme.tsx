// The one place the look is configured (ui-primitives.md section 2): defaults, then the space, then the person. resolveTheme (the Deck's pure
// resolver, shared) picks the accent, scheme, density, font and corners and checks contrast; themeVars turns the result into custom properties;
// the provider writes them on its root view with NativeWind's vars(), so every component restyles with no code of its own.
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { Platform, StyleSheet, useColorScheme, useWindowDimensions, View } from "react-native";
import { vars } from "nativewind";
import { resolveTheme } from "../src/store-core/theme.js";
import { create } from "zustand";
import { PortalHost } from "@rn-primitives/portal";
import { ToastHost } from "./components/Toast";
import { themeVars } from "./theme-vars.js";

export type SpaceTheme = { accent?: string; hex?: string; tint?: string; thex?: string; density?: string; font?: string; corners?: string };
export type PersonTheme = { theme?: "dark" | "paper" | "system"; density?: string | null; font?: string | null; reducedMotion?: boolean; largerText?: boolean };
export type Resolved = {
  scheme: "dark" | "paper"; accent: string; accentInk: string; accentWash: string; tint: string; density: string; font: string; corners: string;
  reducedMotion: boolean; largerText: boolean; note: string | null; own: string[];
};

/** The settings in force: the space's, and the person's. A screen (Appearance) writes here; nothing else does. */
export const useAppearance = create<{ space: SpaceTheme; person: PersonTheme; setSpace: (p: SpaceTheme) => void; setPerson: (p: PersonTheme) => void }>((set) => ({
  space: {},
  person: { theme: "system" },
  setSpace: (p) => set((s) => ({ space: { ...s.space, ...p } })),
  setPerson: (p) => set((s) => ({ person: { ...s.person, ...p } })),
}));

export type UiCtx = { resolved: Resolved; phone: boolean; color: Record<string, string>; map: Record<string, string | number> };
const ThemeCtx = createContext<UiCtx | null>(null);

/** Below this width the phone type scale and the stacked layouts apply. */
export const PHONE_MAX = 768;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const space = useAppearance((s) => s.space);
  const person = useAppearance((s) => s.person);
  const system = useColorScheme() === "light" ? "paper" : "dark";
  const { width } = useWindowDimensions();
  const phone = width < PHONE_MAX;
  const ctx = useMemo<UiCtx>(() => {
    const resolved: Resolved = resolveTheme({ space, person, system });
    // The font is the platform's own (SF, Roboto, the system font on the web) until a space or a person picks Serif; the older "sans" reads as the system font.
    if (resolved.font === "sans") resolved.font = "system";
    const map: Record<string, string | number> = themeVars(resolved, { phone, os: Platform.OS });
    const color: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) if (typeof v === "string") color[k.slice(2)] = v;
    return { resolved, phone, color, map };
  }, [space, person, system, phone]);
  const style = useMemo(() => vars(ctx.map), [ctx]);
  // The web's dialogs and menus are portalled to <body>, outside this view, so they would lose every custom property. Mirror them on the root element.
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const root = document.documentElement;
    const names = Object.keys(ctx.map);
    for (const k of names) root.style.setProperty(k, String(ctx.map[k]));
    return () => { for (const k of names) root.style.removeProperty(k); };
  }, [ctx]);
  return (
    <ThemeCtx.Provider value={ctx}>
      <View style={[StyleSheet.absoluteFill, style]} className="bg-bg">
        {children}
        <ToastHost />
        <PortalHost />
      </View>
    </ThemeCtx.Provider>
  );
}

export function useUiTheme(): UiCtx {
  const c = useContext(ThemeCtx);
  if (!c) throw new Error("useUiTheme outside ThemeProvider");
  return c;
}
