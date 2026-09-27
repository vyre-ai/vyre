// Vyre autofill (modules/vault-android): the types, and the stub every build but Android gets.
// Autofill is Android only. Metro picks autofill.android.ts on Android; the web export and the
// iOS build land here, so neither pulls in the native module. tsc checks screens against this file.

export type Paired = { device: string; name: string; level: string };

export type AutofillStatus = {
  paired: boolean;
  server: string | null;
  device: string | null;
  name: string | null;
  level: string;
  unlocked: boolean;
  enabled: boolean;
  reachable: boolean;
  revoked: boolean;
};

/** False here: autofill is Android only. */
export const supported: boolean = false;

const only = () => Promise.reject(Object.assign(new Error("Autofill is Android only"), { code: "ERR_UNSUPPORTED" }));

export const setServer = (_url: string): Promise<string> => only();
export const pair = (_url: string, _code: string, _name: string): Promise<Paired> => only();
export const status = (): Promise<AutofillStatus> => only();
export const lock = (): Promise<boolean> => only();
export const unpair = (): Promise<boolean> => only();
export const isEnabled = (): boolean => false;
export const openSettings = (): boolean => false;
