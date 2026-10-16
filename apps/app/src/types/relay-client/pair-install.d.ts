// relay/client/pair-install.js: the app's half of an install code. The identity key signs here.
export function mintPairCode(o: {
  person: string;
  publicKey: string;
  sign: (m: Uint8Array) => Uint8Array | Promise<Uint8Array>;
  secret: Uint8Array;
  fingerprint: Uint8Array;
  now?: () => number;
}): Promise<{ code: string; exp: number; person: string }>;

/** The one install line. Linux and an always-on Mac both run it. */
export function installCommand(code: string): string;
