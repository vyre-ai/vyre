import { tokens } from "../../src/theme/tokens";
import { springs } from "./logic.js";

/** tokens.v2.motion, the one source of every duration, spring, stagger and hold in the kit. */
export const motion = tokens.v2.motion;
/** The token springs as reanimated configs: "spatial.fast", "spatial.default", "spatial.slow", "effects.fast", ... */
export const SPRING = springs(motion) as Record<"spatial.fast" | "spatial.default" | "spatial.slow" | "effects.fast" | "effects.default" | "effects.slow", { mass: number; stiffness: number; damping: number; overshootClamping: boolean }>;
