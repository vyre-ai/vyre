import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import { tokens, type Colors, type Scheme } from "./tokens";

export type Palette = { readonly [K in keyof Colors]: string };
export type Theme = { scheme: Scheme; color: Palette };

function themeFor(scheme: Scheme): Theme {
  return { scheme, color: tokens.color[scheme] };
}

const ThemeContext = createContext<Theme>(themeFor("dark"));

/** Picks dark or paper from the system scheme. Dark when the system says nothing. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const scheme: Scheme = system === "light" ? "paper" : "dark";
  const theme = useMemo(() => themeFor(scheme), [scheme]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
