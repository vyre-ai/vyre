// Glass's calls on a real vyred, over an injected `call`: glass.targets (what can be shown), glass.open / glass.close (a one-time stream ticket and its session), glass.take / glass.release
// (the keyboard; neither asks for a passkey), and glass.files.* (list, preview, download and upload tickets, mkdir, move, trash). The screen's bytes and a file's bytes move on the box's own
// stream and raw routes, not here.
import { pickList, pickPreview, pickTargets, type Link, type Holder } from "./model.ts";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;
type Open = { session: string | null; link: Link | null; screen: { path: string; width: number | null; height: number | null } | null };

export function glassSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    async targets() { return pickTargets(await ask("glass.targets")); },
    /** Open the screen: a session, how the box reaches this device, and the stream's path (null when the computer has no screen). */
    async open(target: string, surface: string): Promise<Open> {
      const r = await ask<{ session?: string; link?: { path?: string; latencyMs?: number }; screen?: { path?: string; width?: number; height?: number } }>("glass.open", { target, surface });
      const sc = r?.screen;
      return {
        session: typeof r?.session === "string" ? r.session : null,
        link: r?.link && typeof r.link.path === "string" ? { path: r.link.path, latencyMs: typeof r.link.latencyMs === "number" ? r.link.latencyMs : null } : null,
        screen: sc && typeof sc.path === "string" && sc.path.startsWith("/") ? { path: sc.path, width: typeof sc.width === "number" ? sc.width : null, height: typeof sc.height === "number" ? sc.height : null } : null,
      };
    },
    close: (session: string) => ask("glass.close", { session }),
    /** Take the keyboard (or take it to sign in privately). */
    async take(target: string, surface: string, priv: boolean): Promise<Holder> {
      const r = await ask<{ since?: number; private?: boolean }>("glass.take", { target, surface, ...(priv ? { private: true } : {}) });
      return { surface, since: typeof r?.since === "number" ? r.since : Date.now(), private: Boolean(r?.private ?? priv) };
    },
    async release(target: string, surface: string, note: string): Promise<{ heldMs: number | null }> {
      const r = await ask<{ held_ms?: number }>("glass.release", { target, surface, ...(note.trim() ? { note: note.trim() } : {}) });
      return { heldMs: typeof r?.held_ms === "number" ? r.held_ms : null };
    },
    async list(target: string, path: string) { return pickList(await ask("glass.files.list", { target, ...(path ? { path } : {}) })); },
    async preview(target: string, path: string) { const d = await ask<{ path?: string }>("glass.files.preview", { target, path }); return { preview: pickPreview(d), path: typeof d?.path === "string" ? d.path : "" }; },
    /** A one-time download ticket: the raw route's path and the name to save as. */
    async download(target: string, path: string): Promise<{ path: string; name: string }> {
      const r = await ask<{ path?: string; name?: string }>("glass.files.download", { target, path });
      return { path: String(r?.path ?? ""), name: String(r?.name ?? "") };
    },
    mkdir: (target: string, path: string) => ask("glass.files.mkdir", { target, path }),
    move: (target: string, from: string, to: string) => ask("glass.files.move", { target, from, to }),
    trash: (target: string, path: string) => ask("glass.files.trash", { target, path }),
    /** A one-time upload ticket: the path to PUT the bytes to. */
    async uploadTicket(target: string, dir: string, name: string, size: number, overwrite = false): Promise<string> {
      const r = await ask<{ path?: string }>("glass.files.upload", { target, dir, name, size, ...(overwrite ? { overwrite: true } : {}) });
      return String(r?.path ?? "");
    },
  };
}
