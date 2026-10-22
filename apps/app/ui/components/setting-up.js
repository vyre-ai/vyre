// @ts-check
// A first start sets a Space's Records up, which takes a few minutes. Until then the box answers a records call with `unavailable` and the words "Records is setting up, this takes a few minutes".
// While it is still making its types the store answers `unavailable` with the gateway's plain sentence, "the store could not list its types": that is the same wait, and the app treats it so.
// A screen that fails to load for that reason is not broken: it says so calmly and asks again by itself. Pure.

/** The pause between quiet retries. */
export const SETTING_UP_RETRY_MS = 5_000;

/** Whether a load failed only because Records is still being set up. @param {unknown} reason */
export function isSettingUp(reason) {
  return typeof reason === "string" && /records is setting up|the record store (for this space )?is (still starting|not available yet)|the store could not list its types/i.test(reason);
}

/** What the calm state says. */
export const SETTING_UP_WORDS = Object.freeze({ title: "Records is setting up", body: "This takes a few minutes the first time. This page tries again by itself." });
