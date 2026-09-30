// @ts-check
// Whether keys are Cmd (a Mac, or an iPad with a keyboard) or Ctrl, from the browser's own words.

/** A Mac (or an iPad with a keyboard) uses Cmd; everything else Ctrl. */
export const macKeys = (/** @type {any} */ nav = globalThis.navigator) =>
  /Mac|iPhone|iPad|iPod/.test(String(nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || ""));
