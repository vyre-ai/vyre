// What the app uses of relay/client/chainhello.js: the first hello of a device the person's identity chain lists (design B).
export function chainHello(o: {
  sha256: (b: Uint8Array) => Promise<Uint8Array>;
  devicePub: Uint8Array;
  box: string;
  identity: string;
  entry: string;
  now?: number;
  sign: (m: Uint8Array) => Promise<Uint8Array> | Uint8Array;
  name?: string;
  presencePublicKey?: string;
}): Promise<{ identity: string; entry: string; ts: number; nonce: string; channel: string; sig: string; name?: string; pk?: string }>;
