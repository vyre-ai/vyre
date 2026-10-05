// @ts-check
// store-core/store (moved from the old Deck's ui/store): the one place the generated screens get their Store (contracts.js). Two adapters: the real one (gateway-adapter.js, over a vyred) and the
// in-memory mock (mock-store.js). No screen imports either: they call getStore(), so a swap touches this file only. setStore() is for tests, the lab and the app.
//
// The mock is for development only. In the Expo app (which sets globalThis.__VYRE_APP__ before anything asks for a Store, apps/app/src/api/store-link.ts) there is
// no mock unless allowMock() was called, which that file does only when the build was made with EXPO_PUBLIC_VYRE_MOCK=1 (dev runs, screenshots, captures). A packaged
// build never sets it, so it can never show mock data: with no Vyre connected, getStore() throws and the screen shows its error state. Plain Node (tests, the lab)
// keeps the mock as its default.
import { createMockStore } from "./mock-store.js";

/** @typedef {import("./contracts.js").Store} Store */

/** @type {Store|null} */
let current = null;
let mockOk = false;

/** The app asked for the mock on purpose (a dev or capture build). */
export function allowMock() { mockOk = true; }

/** True where the sample world is in use or allowed: plain Node, or an app build that asked for it. A screen that has a real source of its own reads this to choose. */
export function allowsMock() { return mockOk || !(/** @type {any} */ (globalThis).__VYRE_APP__); }

/** @returns {Store} */
function makeStore() {
  const inApp = Boolean(/** @type {any} */ (globalThis).__VYRE_APP__);
  if (inApp && !mockOk) throw Object.assign(new Error("Not connected to your Vyre yet."), { code: "offline" });
  return createMockStore({ world: "morning" });
}

/** The Store every screen reads. @returns {Store} */
export function getStore() { return (current ??= makeStore()); }

/** Replace the Store (tests, the lab, the app's gateway). Pass null to go back to the default. @param {Store|null} store */
export function setStore(store) { current = store; }
