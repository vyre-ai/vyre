// @ts-check
// A build flag is on only when it is exactly "1". Anything else, unset included, is off. Expo inlines `process.env.EXPO_PUBLIC_NAME` into the bundle only when it is read by that exact literal, so each flag in rc.ts reads its
// own `process.env.NAME` and hands the value here: the literal stays inlinable, and the rule for "on" is one function a test can hold.
/** @param {string | undefined} v */
export const flagOn = (v) => v === "1";
