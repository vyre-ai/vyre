// A fake box for a mock build: the same tools the real Drive calls (files.drive.*, artifacts.*), answered from the sample world in data.ts, so the one Drive screen
// runs unchanged. State lives in the module, per `mockBox()` instance, so a test starts clean.
import type { Call } from "./source";
import { SAMPLE_ARTIFACTS, SAMPLE_FILES, SAMPLE_NOW, type SampleFile } from "./data.ts";

type Out = { data?: unknown; error?: { code: string; message: string } };
const err = (code: string, message = ""): Out => ({ error: { code, message } });
const DAY = 86_400_000;

export function mockBox(now: () => number = () => SAMPLE_NOW) {
  const files: SampleFile[] = SAMPLE_FILES.map((f) => ({ ...f }));
  const links: { code: string; url: string; name: string; path: string; version: number | null; size: number; made_at: number; expires: number; opens: number; active: boolean }[] = [];
  const shared = new Set<string>();
  const at = (p: string) => files.find((f) => f.path === p);
  const b64 = (s: string) => { const T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; const u = Array.from(unescape(encodeURIComponent(s)), (c) => c.charCodeAt(0)); let o = ""; for (let i = 0; i < u.length; i += 3) { const n = (u[i] << 16) | ((u[i + 1] ?? 0) << 8) | (u[i + 2] ?? 0); o += T[(n >> 18) & 63] + T[(n >> 12) & 63] + (i + 1 < u.length ? T[(n >> 6) & 63] : "=") + (i + 2 < u.length ? T[n & 63] : "="); } return o; };

  const call = (async (tool: string, input: Record<string, unknown> = {}): Promise<Out> => {
    const i = input as Record<string, any>;
    switch (tool) {
      case "files.drive.status": return { data: { enabled: true, access: "ro", shares: [{ name: "Documents", access: "ro", shared: true }] } };
      case "files.drive.list": return { data: { share: "Documents", path: String(i.path ?? ""), entries: [{ name: "Notes.txt", dir: false, kind: "text", mime: "text/plain", size: 29, mtime: new Date(SAMPLE_NOW - DAY).toISOString() }], total: 1 } };
      case "files.drive.read": return { data: { share: "Documents", path: String(i.path ?? ""), kind: "text", mime: "text/plain", size: 29, mtime: new Date(SAMPLE_NOW).toISOString(), offset: 0, length: 29, base64: b64("Call Dana Wine about the trust."), done: true } };
      case "files.drive.space.list": return { data: { entries: files.map((f) => ({ path: f.path, size: f.size, ver: f.ver, at: f.at, by: f.by })), next: null } };
      case "files.drive.space.read": { const f = at(String(i.path)); return f ? { data: { path: f.path, version: f.ver, size: f.size, base64: b64(f.text ?? `Sample file ${f.path}`) } } : err("not_found"); }
      case "files.drive.versions": {
        const f = at(String(i.path)); if (!f) return err("not_found");
        return { data: { versions: Array.from({ length: f.ver }, (_, k) => ({ ver: f.ver - k, size: f.size, at: f.at - k * DAY, by: f.by })) } };
      }
      case "files.drive.restore": { const f = at(String(i.path)); if (!f || !(Number(i.version) >= 1 && Number(i.version) < f.ver)) return err("bad_input", "That version cannot be restored."); const from = Number(i.version); f.ver += 1; f.at = now(); return { data: { path: f.path, from, version: f.ver } }; }
      case "files.drive.upload": { const path = String(i.path); const f = at(path); if (f) { f.ver += 1; f.at = now(); return { data: { path, version: f.ver, conflict: false, size: f.size } }; } files.push({ path, ver: 1, at: now(), by: "you", size: 1024 }); return { data: { path, version: 1, conflict: false, size: 1024 } }; }
      case "files.drive.link.create": {
        const f = at(String(i.path)); if (!f) return err("not_found");
        const code = `m${links.length + 1}${f.path.length.toString(36)}`;
        const l = { code, url: `/v1/files/s?c=${code}`, name: f.path.split("/").pop() ?? f.path, path: f.path, version: f.ver, size: f.size, made_at: now(), expires: now() + Math.min(30, Math.max(1, Number(i.days) || 7)) * DAY, opens: 0, active: true };
        links.push(l); return { data: l };
      }
      case "files.drive.link.list": return { data: { links: links.map((l) => ({ ...l })) } };
      case "files.drive.link.revoke": { const k = links.findIndex((l) => l.code === i.code); if (k < 0) return err("not_found"); links.splice(k, 1); return { data: { revoked: true } }; }
      case "artifacts.list": return { data: { artifacts: SAMPLE_ARTIFACTS.map((a) => ({ id: a.id, title: a.title, kind: a.kind, project: a.project, shared: shared.has(a.id) })) } };
      case "artifacts.versions": return { data: { versions: [{ v: 2, at: now(), by: "kit" }, { v: 1, at: now() - DAY, by: "kit" }] } };
      case "artifacts.share": shared.add(String(i.id)); return { data: { url: `/a/${String(i.id)}` } };
      default: return err("not_available", `${tool} is not in the sample world.`);
    }
  }) as unknown as Call;
  return call;
}

/** One box for the whole mock app. */
export const sampleCall: Call = mockBox();
