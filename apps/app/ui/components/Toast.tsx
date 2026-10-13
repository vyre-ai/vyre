import { useEffect } from "react";
import { Pressable, View } from "react-native";
import { create } from "zustand";
import { Text } from "./Text";
import { elevation } from "../lib/elevation";
import { useUiTheme } from "../theme";

const useToasts = create<{ line: string | null; undo: { label: string; run: () => void } | null; set: (l: string | null, undo?: { label: string; run: () => void }) => void }>((set) => ({ line: null, undo: null, set: (line, undo) => set({ line, undo: undo ?? null }) }));

/** One line, four seconds (eight with an action, so there is time to press it: an Undo). */
export function showToast(line: string, undo?: { label: string; run: () => void }) {
  useToasts.getState().set(line, undo);
}

/** The press of a button whose feature is not built yet: it says so in the one phrase every screen uses, never nothing (FOUNDATION section 4). */
export const comingSoon = () => showToast("Coming in this release.");

export function ToastHost() {
  const line = useToasts((s) => s.line);
  const undo = useToasts((s) => s.undo);
  const { resolved } = useUiTheme();
  useEffect(() => {
    if (!line) return;
    const t = setTimeout(() => useToasts.getState().set(null), undo ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [line, undo]);
  if (!line) return null;
  return (
    <View pointerEvents={undo ? "box-none" : "none"} className="absolute bottom-s6 left-0 right-0 items-center px-s4">
      <View accessibilityRole="alert" style={elevation(resolved.scheme, 2)} className="rounded-card border border-edge-strong bg-surface-3 px-s4 py-s3"><View className="flex-row items-center gap-s3"><Text>{line}</Text>{undo ? <Pressable accessibilityRole="button" accessibilityLabel={undo.label} onPress={() => { useToasts.getState().set(null); undo.run(); }}><Text strong tone="accent">{undo.label}</Text></Pressable> : null}</View></View>
    </View>
  );
}
