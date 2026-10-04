// Drive's calls on the real vyred, over an injected `call` (the app's box connection, or a fake box in a test): files.drive.status for the shares,
// files.drive.list a page at a time, files.drive.read one chunk. There is no upload tool on the box yet, so there is none here.
import type { Chunk, Listing, Status } from "./real-model";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;

export function driveSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    statusReal: () => ask<Status>("files.drive.status"),
    listReal: (share: string, path: string, offset = 0) => ask<Listing>("files.drive.list", { share, path, limit: 200, offset }),
    /** The first chunk of a file (up to 1 MiB), enough to show a text file. */
    readReal: (share: string, path: string) => ask<Chunk>("files.drive.read", { share, path, offset: 0, length: 65536 }),
  };
}
