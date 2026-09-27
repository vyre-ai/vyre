// The view cache on the web: core/resilience/web.js cacheStore (IndexedDB, localStorage when
// IndexedDB is refused), one per box. Needs you, Chats and a session's header read from it first.

import { cacheStore } from "@vyre/resilience/web.js";
import { boxName } from "../api/box";

let store: ReturnType<typeof cacheStore> | null = null;
let storeFor = "";

function current() {
  const name = boxName();
  if (!store || storeFor !== name) {
    store = cacheStore(name);
    storeFor = name;
  }
  return store;
}

export const viewCache = {
  async get<T = unknown>(key: string): Promise<T | undefined> {
    try {
      const v = await current().get(key);
      return v ? (v.value as T) : undefined;
    } catch {
      return undefined;
    }
  },
  async set(key: string, value: unknown): Promise<void> {
    try {
      await current().set(key, value);
    } catch {
      // A full or refused store: the view still works, it only opens from the box next time.
    }
  },
};
