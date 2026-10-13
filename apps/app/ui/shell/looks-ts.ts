// Typed view of looks.js for the Shell.
import { LOOKS, LOOK_NAMES, DEFAULT_LOOK as DEFAULT, lookOf as lookOfJs } from "./looks.js";

export type ShellLookName = keyof typeof LOOKS;
export type ShellLook = (typeof LOOKS)[ShellLookName];
export const lookOf = (name?: string): ShellLook => lookOfJs(name);
export const DEFAULT_LOOK: ShellLookName = DEFAULT;
export { LOOKS, LOOK_NAMES };
