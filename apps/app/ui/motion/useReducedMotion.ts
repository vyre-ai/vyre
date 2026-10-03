import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";
import { useAppearance } from "../theme";
import { resolveReducedMotion } from "./logic.js";

/** The system's reduced-motion setting, live (iOS, Android and the browser's prefers-reduced-motion all come through AccessibilityInfo). */
function useOsReducedMotion(): boolean {
  const [os, setOs] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled?.().then((v) => { if (alive) setOs(!!v); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.("reduceMotionChanged", (v: boolean) => setOs(!!v));
    return () => { alive = false; sub?.remove?.(); };
  }, []);
  return os;
}

/**
 * True when motion should stop: the person set Reduce motion in Appearance, or the system asks for it. When true, springs, slides, shimmer and
 * scale stop; a state change still shows (a fade or a colour), so nothing becomes silent.
 */
export function useReducedMotion(): boolean {
  const person = useAppearance((s) => s.person.reducedMotion);
  const os = useOsReducedMotion();
  return resolveReducedMotion({ person, os });
}
