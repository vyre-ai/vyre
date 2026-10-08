// relay/client/peerclient.js (wink-2): the calling side of the peer wire to a paired server; the server runs every call as this device with its paired session as the person.
export type PeerStream = { id: string; result: any; close(): void };
export type Peer = { readonly closed: boolean; call(tool: string, input?: unknown, opt?: { timeoutMs?: number }): Promise<any>; openStream(tool: string, input: unknown, h: { onframe(data: any, seq: number): void; onend(why: string): void }): Promise<PeerStream>; close(): void };
export function peerClient(stream: unknown, o?: { timeoutMs?: number }): Peer;
export function openServerPeer(conn: { ready(): Promise<any> }, o?: { space?: string; timeoutMs?: number; invitee?: unknown }): Promise<Peer>;
