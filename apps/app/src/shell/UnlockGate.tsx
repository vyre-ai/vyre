import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState, Platform, StyleSheet, View } from "react-native";
import { ThemeProvider as UiThemeProvider } from "@vyre/ui";
import { MOCK } from "../real/box";
import { useTheme } from "../theme/theme";
import { UnlockScreen } from "../../screens/unlock/UnlockScreen";
import { identityState, lockIdentity } from "../../screens/unlock/real.js";
import { applyCover, createIdleLock, lockView, lockWanted } from "./lock-gate.js";
import { onLockChanged, onLockMinutes, readLockMinutes } from "./lock-setting";

/**
 * Coming back to the app: an identity that is made but locked on this device is asked for its master password before anything else draws, and a legacy identity with no master password is
 * asked for one (the cover is the whole window, over every route, and the app stays mounted under it). While the identity is unlocked, a quiet spell locks it again (the person picks how long in
 * Settings, Account; the default is 15 minutes). The state is read at start, when the app comes back to the front, and after every unlock or lock. A build with no identity answers nothing and is never gated.
 */
export function UnlockGate({ children }: { children: ReactNode }) {
  const { color } = useTheme();
  const [status, setStatus] = useState<{ exists?: boolean; unlocked?: boolean; needsMigration?: boolean; unreachable?: boolean; username?: string | null } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const under = useRef<View | null>(null);
  const [minutes, setMinutes] = useState<number | null>(null);
  const lock = useRef<ReturnType<typeof createIdleLock> | null>(null);

  const refresh = useCallback(async () => { if (MOCK) return; setStatus(await identityState()); setLoaded(true); }, []);
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

  // Fail closed: until the first read answers, and whenever a read fails, the app stays covered. Under the cover the app is inert on the web (no keyboard, no screen reader) and hidden on a phone.
  const view = MOCK ? "none" : lockView(status, loaded);
  const covered = view !== "none";
  useEffect(() => {
    if (Platform.OS === "web") applyCover(under.current as unknown as Parameters<typeof applyCover>[0], covered);
  }, [covered]);
  return (
    <View style={styles.fill} onTouchStart={() => lock.current?.touch()}>
      <View ref={under} style={styles.fill} importantForAccessibility={covered ? "no-hide-descendants" : "auto"} accessibilityElementsHidden={covered}>{children}</View>
      {!covered ? null : (
        <View accessibilityViewIsModal style={[StyleSheet.absoluteFill, { backgroundColor: color.bg }]}>
          {/* The screens come from the component library, whose own theme provider the routes mount (app/onboard.tsx); the cover sits above every route, so it mounts one itself. */}
          {view === "pending" ? null : <UiThemeProvider><UnlockScreen key={view} view={view} username={status?.username} onDone={() => void refresh()} onRetry={() => void refresh()} /></UiThemeProvider>}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
