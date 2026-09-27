import { useEffect, useState } from "react";
import { AccessibilityInfo, Platform, useWindowDimensions } from "react-native";
import { tokens } from "../theme/tokens";

/** A mouse or trackpad is the main pointer: the web build on a desktop. Never true on a phone. */
export const finePointer: boolean =
  Platform.OS === "web" && typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches;

/**
 * The desktop shape (layout.md): 720 wide and up, with a fine pointer. Desktop sizes (32 buttons)
 * and key hints only here; a touch-only device keeps 44 targets at any width.
 */
export function useDesk(): boolean {
  const { width } = useWindowDimensions();
  return finePointer && width >= tokens.layout.breakpoints.medium;
}

/** The person asked for less motion: spinners stop as a static arc, slides go. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled().then((r) => live && setReduced(r), () => {});
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return reduced;
}
