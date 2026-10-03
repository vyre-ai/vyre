// @ts-check
// deck/ui/store: the one place the Deck's generated screens get their Store (contracts.js). Today it is the in-memory mock; when platform's gateway adapter
// (kernel/contracts/, on branch work/kernel) lands, ADAPTER below becomes "gateway" and makeStore() builds it. No screen imports mock-store.js or the gateway:
// they call getStore(), so the swap touches this file only. setStore() is for tests and the lab (a screen reads getStore() on every draw).
import { createMockStore } from "./mock-store.js";

/** @typedef {import("./contracts.js").Store} Store */

/** The switch. "mock" until the gateway adapter exists. */
const ADAPTER = /** @type {"mock"|"gateway"} */ ("mock");

/** @returns {Store} */
function makeStore() {
  if (ADAPTER === "gateway") throw new Error("The gateway adapter has not landed yet (kernel/contracts/).");
  return createMockStore({ world: "morning" });
}

/** @type {Store|null} */
let current = null;

/** The Store every screen reads. @returns {Store} */
export function getStore() { return (current ??= makeStore()); }

/** Replace the Store (tests, the lab). Pass null to go back to the default. @param {Store|null} store */
export function setStore(store) { current = store; }
