import { useEffect, useState, type ReactNode } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { router, usePathname } from "expo-router";
import { boxOrigin } from "../api/box";
import { MOCK } from "../real/box";
import { isBoxless } from "./shell";
import { hostWanted } from "../host";
import { loadPairing } from "../api/relay";
import { useTheme } from "../theme/theme";
import { readSkipped } from "../state/setup-progress";
import { tool } from "../real/box";
import { gateTarget } from "./setup-gate.js";

/**
 * A fresh install has no server: send it to setup, and keep the shell out of reach until a pairing exists. The pairing is read again on every route change, so
 * the moment setup saves it the next move lands in the app. The navigator stays mounted (a redirect needs it); a plain cover hides it until the first read so the empty shell never flashes. The web page is its box's own origin, so it never gates.
 */
export function SetupGate({ children }: { children: ReactNode }) {
  const path = usePathname();
  // The phone, the Mac app's window on a server Mac (no vyred of its own), and the Windows app's window (always the bundled app); a browser page is its box's own origin and never gates.
  // A mock build (EXPO_PUBLIC_VYRE_MOCK=1) is the sample world, already set up: it opens in the app. /onboard stays reachable by its address for review.
  const gated = !MOCK && (Platform.OS !== "web" || isBoxless() || hostWanted());
  const { color } = useTheme();
  const [checked, setChecked] = useState(!gated);
  useEffect(() => {
    if (!gated) return;
    let live = true;
    // The check can fail or stall (a locked store, a shell that never answers). It must never leave the cover up for ever: after 4 s, or on an error, the person goes to setup, which can always draw.
    const giveUp = setTimeout(() => { if (!live) return; live = false; setChecked(true); const to = gateTarget({ path, paired: false, direct: false, skipped: false }); if (to) router.replace(to as never); }, 4000);
    void Promise.all([loadPairing(), readSkipped(), tool("onboard.status").catch(() => null)]).then(([p, skipped, st]) => {
      if (!live) return;
      clearTimeout(giveUp);
      const firstRun = Boolean(st && typeof st === "object" && (st as { firstRun?: string }).firstRun === "open");
      const to = gateTarget({ path, paired: !!p, direct: Platform.OS !== "web" && !!boxOrigin(), skipped, firstRun });
      setChecked(true);
      if (to) router.replace(to as never);
    }, () => {
      if (!live) return;
      clearTimeout(giveUp);
      setChecked(true);
      const to = gateTarget({ path, paired: false, direct: false, skipped: false });
      if (to) router.replace(to as never);
    });
    return () => { live = false; clearTimeout(giveUp); };
  }, [path]);
  return (
    <>
      {children}
      {checked ? null : <View pointerEvents="auto" style={[StyleSheet.absoluteFill, { backgroundColor: color.bg }]} />}
    </>
  );
}
