// The one door the /u screens use to read and write the real box: the box's own tools through
// src/api/box (POST /v1/tools/<name> over the paths layer). The sample data stays for development:
// it is on only when EXPO_PUBLIC_VYRE_MOCK=1; otherwise a screen shows what the box answers, an empty
// state when it has nothing, and an error line when it cannot be reached. Never sample people.

import { call } from "../api/box";
import { wantsPasskey } from "./presence-model.js";
import { passkeyProof, PresenceError } from "./presence";

/** True only in a development build started with EXPO_PUBLIC_VYRE_MOCK=1. */
export const MOCK: boolean = typeof process !== "undefined" && process.env?.EXPO_PUBLIC_VYRE_MOCK === "1";

export class BoxError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message || code);
    this.code = code;
  }
}

/** One tool call; resolves the data, throws BoxError with the box's own code and words. */
export async function tool<T = unknown>(name: string, input: Record<string, unknown> = {}): Promise<T> {
  let r = await call<T>(name, input).catch((e: Error) => ({ error: { code: "offline", message: e.message } }) as const);
  // A human-only call: the box asks for presence, and in a browser the person's passkey answers it. Once, for this call.
  if (r.error && wantsPasskey(r.error)) {
    try {
      const proof = await passkeyProof(name, input);
      r = await call<T>(name, input, { presence: proof }).catch((e: Error) => ({ error: { code: "offline", message: e.message } }) as const);
    } catch (e) {
      if (e instanceof PresenceError) throw new BoxError(e.code, e.message);
      throw e;
    }
  }
  if (r.error) throw new BoxError(r.error.code ?? "error", r.error.message ?? "");
  return r.data as T;
}

/** The words to show for a failed call. */
export const said = (e: unknown): string => (e instanceof BoxError ? (e.code === "offline" || /no JSON/i.test(e.message) ? "Cannot reach your server right now." : /anonymous callers/i.test(e.message) ? "This browser is not signed in to your server yet. Pair it first." : e.message) : "Something went wrong.");
