// Drop a Space from this computer: the pairing, the kept shell, the host's kept Spaces and the saved root. Nothing here calls a server, so a server that is gone can still be removed.
import { clearQuiet } from "./server-wait";

type SpaceRow = { id: string; server?: string; quiet?: boolean };
type ShellPack = { v: 1; at: number; space: string; data: { me: unknown; spaces: SpaceRow[] } };
type HostSpace = { id?: string; paired?: { box?: string } | null };
type HostKept = { spaces?: HostSpace[]; current?: string | null };

/** The paired server of each Space the host keeps, by space id. */
export function keptBoxes(k: HostKept | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of k?.spaces ?? []) if (s?.id && s.paired?.box) out[s.id] = s.paired.box;
  return out;
}

/**
 * Mark Spaces whose server did not answer, or whose pairing is already gone while this computer is still paired to another. `paired` null means the pairings could not be read, so a missing pairing is not treated as gone. An empty pairing list is this computer's own server, not every Space gone.
 * A Space with no server is left as it is.
 */
export function markQuietSpaces<T extends SpaceRow>(spaces: T[], offline: string[], boxes: Record<string, string>, paired: string[] | null): T[] {
  const down = new Set(offline);
  const have = paired ? new Set(paired) : null;
  return spaces.map((s) => {
    const known = s.server && !/^https?:/i.test(s.server) ? s.server : "";
    const box = known || boxes[s.id] || "";
    if (!box) return s;
    const quiet = down.has(box) || (have !== null && have.size > 0 && !have.has(box));
    if (!quiet && box === (s.server ?? "")) return s;
    return { ...s, server: box, ...(quiet ? { quiet: true } : {}) };
  });
}

export type DropPorts = {
  removePairingFor: (box: string) => Promise<void>;
  shellGet: () => Promise<ShellPack | null>;
  shellSet: (v: ShellPack) => Promise<void>;
  hostLoad: () => Promise<HostKept | null>;
  hostSave: (k: HostKept) => Promise<void>;
  rootsRead: () => Promise<Record<string, string>>;
  rootsWrite: (all: Record<string, string>) => Promise<void>;
};

/**
 * Remove one Space, or every Space of one server, from this computer. The next Space is the one left showing.
 * Pairing, shell, host Spaces and roots are all cleared. A store that has nothing matching is left as it was.
 */
export async function dropSpaceHere(o: { space?: string; box?: string } & DropPorts): Promise<{ removed: string[]; boxes: string[]; next: string }> {
  const host = await o.hostLoad();
  const shell = await o.shellGet();
  const spaces = new Set<string>();
  const boxes = new Set<string>();
  if (o.space) spaces.add(o.space);
  if (o.box) boxes.add(o.box);
  for (const s of host?.spaces ?? []) {
    const b = s?.paired?.box || "";
    if (!s?.id) continue;
    if ((o.space && s.id === o.space) || (o.box && b === o.box)) { spaces.add(s.id); if (b) boxes.add(b); }
  }
  for (const s of shell?.data?.spaces ?? []) {
    const b = s?.server && !/^https?:/i.test(s.server) ? s.server : "";
    if (!s?.id) continue;
    if ((o.space && s.id === o.space) || (o.box && b && b === o.box)) { spaces.add(s.id); if (b) boxes.add(b); }
  }
  for (const b of boxes) await o.removePairingFor(b);
  let next = shell?.space ?? "";
  if (host) {
    const rest = (host.spaces ?? []).filter((s) => s && !spaces.has(String(s.id)) && !(o.box && s.paired?.box === o.box));
    const current = host.current && spaces.has(host.current) ? (rest[0]?.id ?? null) : (host.current ?? null);
    await o.hostSave({ ...host, spaces: rest, current });
  }
  if (shell?.data) {
    const rest = shell.data.spaces.filter((s) => s && !spaces.has(s.id) && !(o.box && s.server === o.box));
    next = spaces.has(shell.space) ? (rest[0]?.id ?? "") : shell.space;
    await o.shellSet({ ...shell, space: next, data: { ...shell.data, spaces: rest } });
  }
  const roots = { ...(await o.rootsRead()) };
  let changed = false;
  for (const id of spaces) if (id in roots) { delete roots[id]; changed = true; }
  if (changed) await o.rootsWrite(roots);
  for (const b of boxes) clearQuiet(b);
  return { removed: [...spaces], boxes: [...boxes], next };
}

/** The app's own stores: pairing, shell cache, host Spaces, roots, then the switcher moves to the next Space. */
export async function removeFromComputer(o: { space?: string; box?: string }): Promise<{ next: string }> {
  const { removePairingFor } = await import("../api/relay");
  const { viewCache } = await import("../state/cache");
  const { hostStore } = await import("../host/host-store");
  const { readRoots, writeRoots } = await import("../state/space-roots");
  const { SHELL_KEY, unpackShell } = await import("../../screens/shell/shell-cache.js");
  const { useShell } = await import("../../screens/shell/shared");
  const { useSpaces } = await import("../../screens/shell/state");
  const { forgetServer } = await import("./space-servers");
  const got = await dropSpaceHere({
    ...o,
    removePairingFor,
    shellGet: async () => {
      const unpacked = unpackShell(await viewCache.get(SHELL_KEY));
      if (unpacked) return { v: 1, at: Date.now(), space: unpacked.space, data: unpacked.data };
      return { v: 1, at: Date.now(), space: useSpaces.getState().space, data: useShell.getState().data };
    },
    shellSet: async (v) => { await viewCache.set(SHELL_KEY, v); },
    hostLoad: async () => hostStore.load(),
    hostSave: async (k) => { await hostStore.save(k as never); },
    rootsRead: readRoots,
    rootsWrite: writeRoots,
  });
  for (const b of got.boxes) forgetServer(b);
  const cur = useShell.getState().data;
  const spaces = cur.spaces.filter((s) => !got.removed.includes(s.id) && !(o.box && s.server === o.box));
  useShell.getState().set({ ...cur, spaces });
  const showing = useSpaces.getState().space;
  const next = spaces.some((s) => s.id === showing) ? showing : (got.next && spaces.some((s) => s.id === got.next) ? got.next : (spaces[0]?.id ?? ""));
  if (next !== showing) useSpaces.getState().setShowing(next);
  return { next };
}
