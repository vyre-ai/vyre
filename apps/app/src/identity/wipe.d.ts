// Types for the platform files: wipe.web.ts and wipe.native.ts.
import type { WipeStep } from "./wipe.js";
/** What this platform holds, as steps to forget it (the browser's storage, or the phone's keychain and keys). */
export function deviceSteps(): WipeStep[];
/** After the wipe: send the person to the screen that pairs the device again. */
export function afterWipe(): void;
