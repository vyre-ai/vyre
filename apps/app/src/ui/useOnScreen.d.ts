// Types for the platform files: useOnScreen.web.ts (IntersectionObserver) and useOnScreen.native.ts
// (measureInWindow on layout and on the scroller's signal).
import type { RefObject } from "react";
import type { View } from "react-native";

/** Whether the view behind `ref` overlaps the screen now. False until it has been laid out once. */
export function useOnScreen(ref: RefObject<View | null>): boolean;
