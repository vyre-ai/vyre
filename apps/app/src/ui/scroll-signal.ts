// The scroll signal a scroller hands to the views inside it (useOnScreen.native.ts). Null outside a
// scroller: a view there measures itself once, when it is laid out.
import { createContext } from "react";
import { createScrollSignal } from "./onscreen.js";

export type Signal = ReturnType<typeof createScrollSignal>;
export const ScrollSignal = createContext<Signal | null>(null);
export { createScrollSignal };
