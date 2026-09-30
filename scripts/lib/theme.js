// @ts-check
// Theme overrides (ADR 0033 section 3) moved to lib/theme, the pure library vyred runs too. This
// file keeps the old import path working for the scripts and tests that use it.
export { ALLOWED, applyOverride, check, contrast, fromLegacy, PAIRS } from "../../lib/theme/index.js";
