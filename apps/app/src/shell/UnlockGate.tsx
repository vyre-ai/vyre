import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState, Platform, StyleSheet, View } from "react-native";
import { MOCK } from "../real/box";
import { useTheme } from "../theme/theme";
import { UnlockScreen } from "../../screens/unlock/UnlockScreen";
import { identityState, lockIdentity } from "../../screens/unlock/real.js";
import { createIdleLock, lockView, lockWanted } from "./lock-gate.js";
import { onLockChanged, onLockMinutes, readLockMinutes } from "./lock-setting";

/**
 * Coming back to the app: an identity that is made but locked on this device is asked for its master password before anything else draws, and a legacy identity with no master password is
 * asked for one (the cover is the whole window, over every route, and the app stays mounted under it). While the identity is unlocked, a quiet spell locks it again (the person picks how long in
 * Settings, Account; the default is 15 minutes). The state is read at start, when the app comes back to the front, and after every unlock or lock. A build with no identity answers nothing and is never gated.
 */
export function UnlockGate({ children }: { children: ReactNode }) {
  const { color } = useTheme();
  const [status, setStatus] = useState<{ exists?: boolean; unlocked?: boolean; needsMigration?: boolean; username?: string | null } | null>(null);
  const [minutes, setMinutes] = useState<number | null>(null);
  const lock = useRef<ReturnType<typeof createIdleLock> | null>(null);

  const refresh = useCallback(async () => { if (!MOCK) setStatus(await identityState()); }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    void readLockMinutes().then(setMinutes);
    const stops = [onLockMinutes(setMinutes), onLockChanged(() => { void refresh(); })];
    return () => stops.forEach((stop) => stop());
  }, [refresh]);
  // The app comes back to the front: the lock may have happened while it was away (the server restarted, or this device locked).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") void refresh(); });
    const onFocus = () => { void refresh(); };
    if (Platform.OS === "web" && typeof window !== "undefined") window.addEventListener("focus", onFocus);
    return () => { sub.remove(); if (Platform.OS === "web" && typeof window !== "undefined") window.removeEventListener("focus", onFocus); };
  }, [refresh]);

  const wanted = minutes !== null && lockWanted(status, minutes);
  useEffect(() => {
    if (!wanted || minutes === null) return;
    const l = createIdleLock({ minutes, onIdle: () => { void lockIdentity().then(refresh); } });
    lock.current = l;
    l.start();
    const touch = () => l.touch();
    const doc = Platform.OS === "web" && typeof document !== "undefined" ? document : null;
    const events = ["pointerdown", "keydown", "wheel", "touchstart"];
    if (doc) events.forEach((e) => doc.addEventListener(e, touch, { passive: true, capture: true }));
    return () => { l.stop(); lock.current = null; if (doc) events.forEach((e) => doc.removeEventListener(e, touch, { capture: true })); };
  }, [wanted, minutes, refresh]);

  const view = MOCK ? "none" : lockView(status);
  return (
    <View style={styles.fill} onTouchStart={() => lock.current?.touch()}>
      {children}
      {view === "none" ? null : (
        <View accessibilityViewIsModal style={[StyleSheet.absoluteFill, { backgroundColor: color.bg }]}>
          <UnlockScreen key={view} view={view} username={status?.username} onDone={() => void refresh()} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
