// Types for the platform files: cache.web.ts and cache.native.ts.
/** The last value a view showed, per box, so the app opens from it before the box answers (ADR 0029, R3). */
export const viewCache: {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  /** Forget everything cached (a removed device). */
  clear(): Promise<void>;
};
