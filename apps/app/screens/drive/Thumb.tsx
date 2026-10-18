// A small picture of an image file in the grid. Only an image that is small (the whole file is read once, here, to draw it), only from the Space or a linked folder, a few at a time; anything else keeps its
// icon. The picture lives in this window's memory and is dropped when the tile goes.
import { useEffect, useState } from "react";
import { Icon } from "@vyre/ui";
import { spaceRead, linked } from "./real";

const MAX_THUMB = 600 * 1024;
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const cache = new Map<string, string>();
let running = 0;
const waiting: (() => void)[] = [];
const turn = () => new Promise<void>((go) => { const start = () => { running++; go(); }; if (running < 3) start(); else waiting.push(start); });
const done = () => { running--; waiting.shift()?.(); };

export function canThumb(r: { dir: boolean; kind: string; size: number; root: string; name: string }): boolean {
  return !r.dir && r.kind === "image" && r.size > 0 && r.size <= MAX_THUMB && (r.root === "space" || r.root === "linked") && Boolean(TYPES[r.name.split(".").pop()?.toLowerCase() ?? ""]);
}

export function Thumb({ row, fallback }: { row: { key: string; path: string; root: string; link?: string; name: string; dir: boolean; kind: string; size: number }; fallback: string }) {
  const [src, setSrc] = useState<string | null>(cache.get(row.key) ?? null);
  useEffect(() => {
    if (src || !canThumb(row)) return;
    let live = true;
    void turn().then(async () => {
      try {
        const b64 = row.root === "space" ? (await spaceRead(undefined, row.path)).base64 : row.link ? (await linked.read(row.link, row.path)).base64 : "";
        if (!b64 || !live) return;
        const url = `data:${TYPES[row.name.split(".").pop()!.toLowerCase()]};base64,${b64}`;
        cache.set(row.key, url);
        setSrc(url);
      } catch { /* the icon stays */ } finally { done(); }
    });
    return () => { live = false; };
  }, [row.key]); // eslint-disable-line react-hooks/exhaustive-deps
  return src ? <img alt="" src={src} style={{ maxWidth: "100%", maxHeight: 56, borderRadius: 6, objectFit: "cover" }} /> : <Icon name={fallback as never} tone="text-2" size={44 as never} />;
}
