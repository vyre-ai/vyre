import { useMemo } from "react";
import { parse } from "react-native-svg";
import { markKey, markSource, seedOf, slug as slugOf, type MarkKind, type Scheme, type DeviceType } from "./source.js";
import { useUiTheme } from "../theme";

/** A parsed mark, kept for the life of the app: lists render dozens, so each (kind, seed, size band, scheme) is parsed once, never per row. */
const CACHE = new Map<string, ReturnType<typeof parse>>();
const MAX = 512;

export type MarkRef = { kind: MarkKind; id: string; name: string; seed?: string; device?: DeviceType };

export function astFor(of: MarkRef, size: number, scheme: Scheme) {
  const seed = seedOf(of);
  const key = markKey(of.kind, seed, size, scheme, of.device ?? "");
  let ast = CACHE.get(key);
  if (ast === undefined) {
    ast = parse(markSource(of.kind, seed, scheme, { size, device: of.device }));
    CACHE.set(key, ast);
    if (CACHE.size > MAX) CACHE.delete(CACHE.keys().next().value as string);
  } else {
    CACHE.delete(key);
    CACHE.set(key, ast);
  }
  return ast;
}

/** The parsed mark for a reference at a size, in the current scheme. */
export function useMark(of: MarkRef, size: number) {
  const { resolved } = useUiTheme();
  const { kind, id, name, seed, device } = of;
  return useMemo(() => astFor({ kind, id, name, seed, device }, size, resolved.scheme), [kind, id, name, seed, device, size, resolved.scheme]);
}

/** A reference by name when a screen has no id of its own (the sample world's labels): the id is the name's slug, the seed the same. */
export function markRef(kind: MarkRef["kind"], name: string, id?: string, seed?: string): MarkRef {
  return { kind, id: id ?? slugOf(name), name, seed };
}

/** A space's mark: seeded by its name's slug in every place that shows it, so one space looks the same in the rail, on a card badge and in Settings. */
export function spaceRef(name: string, id?: string, seed?: string): MarkRef {
  return { kind: "space", id: id ?? slugOf(name), name, seed: seed ?? slugOf(name) };
}
