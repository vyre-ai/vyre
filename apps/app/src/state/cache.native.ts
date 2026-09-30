// The view cache on the phone: in memory until MMKV or SQLite lands behind the same shape (the
// outbox and cursor wait for the same store, box.native.ts).

const mem = new Map<string, unknown>();

export const viewCache = {
  async get<T = unknown>(key: string): Promise<T | undefined> {
    return mem.get(key) as T | undefined;
  },
  async set(key: string, value: unknown): Promise<void> {
    mem.set(key, value);
  },
};
