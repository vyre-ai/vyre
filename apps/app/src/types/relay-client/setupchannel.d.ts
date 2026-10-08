// relay/client/setupchannel.js: the app's connection to a server it is adding, over the relay, admitted for its setup key alone.
export function connectSetup(lib: unknown, o: { offer: { relay: string; route: string; box: Uint8Array }; key: { privateKey: CryptoKey; spki: Uint8Array }; secret: Uint8Array; WebSocket?: unknown; timeout?: number }): Promise<{
  call(tool: string, input?: object): Promise<any>;
  close(): void;
}>;
