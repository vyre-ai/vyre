// A fake box for a mock build: the same tools the real Drive calls (files.drive.space.*, files.linked.*, artifacts.*), answered from the sample world in data.ts, so the one Drive screen
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

  // Files > Linked in the sample world: one source, a small tree, revs that move on every save.
  const linked: { id: string; name: string; path: string; provider: string; source: Record<string, unknown>; linked_by: string; at: number }[] = [];
  const tree = new Map<string, { text: string; rev: number; at: number }>([["Plans/launch.md", { text: "The launch plan.", rev: 1, at: SAMPLE_NOW - 2 * DAY }], ["budget.txt", { text: "Budget numbers.", rev: 1, at: SAMPLE_NOW - DAY }]]);
  const lnk = (i: Record<string, any>) => linked.find((l) => l.id === i.id);
  const lsOf = (l: { name: string }, dir: string) => {
    const pre = dir ? `${dir}/` : ""; const out = new Map<string, any>();
    for (const [p, f] of tree) { if (!p.startsWith(pre)) continue; const rest = p.slice(pre.length), head = rest.split("/")[0]; out.set(head, rest.includes("/") ? { name: head, path: `Linked/${l.name}/${pre}${head}`, dir: true, size: 0, modified: null, rev: null } : { name: head, path: `Linked/${l.name}/${p}`, dir: false, size: f.text.length, modified: f.at, rev: String(f.rev) }); }
    return [...out.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  };

  const call = (async (tool: string, input: Record<string, unknown> = {}): Promise<Out> => {
    const i = input as Record<string, any>;
    switch (tool) {
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
      case "files.linked.providers": return { data: { providers: [{ id: "gdrive", label: "Google Drive", pick: true }] } };
      case "files.linked.pick": return { data: { parent: String(i.parent ?? "root"), folders: i.parent ? [] : [{ id: "F1", name: "Client docs" }, { id: "F2", name: "Archive" }] } };
      case "files.linked.link": { if (linked.some((l) => l.name === i.name)) return err("conflict", `Linked/${i.name} is already a linked folder`); const l = { id: `lnk_${linked.length + 1}`, name: String(i.name), path: `Linked/${i.name}`, provider: String(i.provider), source: i.source, linked_by: "you", at: now() }; linked.push(l); return { data: l }; }
      case "files.linked.list": return { data: { links: linked.map((l) => ({ ...l })) } };
      case "files.linked.unlink": { const k = linked.findIndex((l) => l.id === i.id); if (k < 0) return err("not_found"); linked.splice(k, 1); return { data: { unlinked: true } }; }
      case "files.linked.sync": return lnk(i) ? { data: { status: "ok", count: tree.size, at: now() } } : err("not_found");
      case "files.linked.status": return lnk(i) ? { data: { link: lnk(i), sync: { status: "ok", count: tree.size, at: now() } } } : err("not_found");
      case "files.linked.ls": { const l = lnk(i); return l ? { data: { path: `Linked/${l.name}`, entries: lsOf(l, String(i.path ?? "")) } } : err("not_found"); }
      case "files.linked.read": { const l = lnk(i), f = tree.get(String(i.path)); return l && f ? { data: { path: `Linked/${l.name}/${i.path}`, name: String(i.path).split("/").pop(), mime: "text/plain", rev: String(f.rev), size: f.text.length, base64: b64(f.text) } } : err("not_found"); }
      case "files.linked.write": {
        const l = lnk(i); if (!l) return err("not_found");
        const f = tree.get(String(i.path));
        if (f && i.base_rev !== undefined && String(f.rev) !== String(i.base_rev)) return err("conflict");
        const text = decodeURIComponent(escape(atob(String(i.base64)))); const rev = (f?.rev ?? 0) + 1;
        tree.set(String(i.path), { text, rev, at: now() }); return { data: { path: `Linked/${l.name}/${i.path}`, rev: String(rev) } };
      }
      case "files.linked.versions": { const f = tree.get(String(i.path)); return f ? { data: { versions: Array.from({ length: f.rev }, (_, k) => ({ rev: String(f.rev - k), modified: f.at - k * DAY, by: "You" })) } } : err("not_found"); }
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
