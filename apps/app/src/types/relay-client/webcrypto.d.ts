// What the app uses of relay/client/webcrypto.js (see client.d.ts for why this file exists).
export type KeyPair = { privateKey: any; publicKey: Uint8Array };
export type KeyStore = { get(): Promise<KeyPair | null>; set(keyPair: KeyPair): Promise<void> };
export type CryptoProvider = {
  generateKeyPair(): Promise<KeyPair>;
  randomBytes(n: number): Uint8Array;
  importKeyPair(raw: Uint8Array): Promise<KeyPair>;
  [k: string]: unknown;
};
export function webCrypto(o?: { subtle?: SubtleCrypto; getRandomValues?: (a: Uint8Array) => Uint8Array }): CryptoProvider;
export function indexedDbKeyStore(o?: { indexedDB?: IDBFactory; db?: string; store?: string; key?: string }): KeyStore;
export function memoryKeyStore(): KeyStore;
