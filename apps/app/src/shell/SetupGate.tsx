import { useEffect, useState, type ReactNode } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { router, usePathname } from "expo-router";
import { boxOrigin } from "../api/box";
import { shell } from "./shell";
import { loadPairing } from "../api/relay";
import { useTheme } from "../theme/theme";
import { readSkipped } from "../state/setup-progress";
import { gateTarget } from "./setup-gate.js";

/**
 * A fresh install has no server: send it to setup, and keep the shell out of reach until a pairing exists. The pairing is read again on every route change, so
 * the moment setup saves it the next move lands in the app. The navigator stays mounted (a redirect needs it); a plain cover hides it until the first read so the empty shell never flashes. The web page is its box's own origin, so it never gates.
 */
export function SetupGate({ children }: { children: ReactNode }) {
  const path = usePathname();
  // The phone, and the Mac app's window on a server Mac (no vyred of its own); a browser page is its box's own origin and never gates.
  const gated = Platform.OS !== "web" || !!shell()?.boxless;
  const { color } = useTheme();
  const [checked, setChecked] = useState(!gated);
  useEffect(() => {
    if (!gated) return;
    let live = true;
    void Promise.all([loadPairing(), readSkipped()]).then(([p, skipped]) => {
      if (!live) return;
      const to = gateTarget({ path, paired: !!p, direct: Platform.OS !== "web" && !!boxOrigin(), skipped });
      setChecked(true);
      if (to) router.replace(to as never);
    });
    return () => { live = false; };
  }, [path]);
  return (
    <>
      {children}
      {checked ? null : <View pointerEvents="auto" style={[StyleSheet.absoluteFill, { backgroundColor: color.bg }]} />}
    </>
  );
}
