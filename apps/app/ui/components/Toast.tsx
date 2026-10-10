import { useEffect } from "react";
import { View } from "react-native";
import { create } from "zustand";
import { Text } from "./Text";
import { elevation } from "../lib/elevation";
import { useUiTheme } from "../theme";

const useToasts = create<{ line: string | null; set: (l: string | null) => void }>((set) => ({ line: null, set: (line) => set({ line }) }));

/** One line, four seconds. */
export function showToast(line: string) {
  useToasts.getState().set(line);
}

/** The press of a button whose feature is not built yet: it says so in the one phrase every screen uses, never nothing (FOUNDATION section 4). */
export const comingSoon = () => showToast("Coming in this release.");

export function ToastHost() {
  const line = useToasts((s) => s.line);
  const { resolved } = useUiTheme();
  useEffect(() => {
    if (!line) return;
    const t = setTimeout(() => useToasts.getState().set(null), 4000);
    return () => clearTimeout(t);
  }, [line]);
  if (!line) return null;
  return (
    <View pointerEvents="none" className="absolute bottom-s6 left-0 right-0 items-center px-s4">
      <View accessibilityRole="alert" style={elevation(resolved.scheme, 2)} className="rounded-card border border-edge-strong bg-surface-3 px-s4 py-s3"><Text>{line}</Text></View>
    </View>
  );
}
