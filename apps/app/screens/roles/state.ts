// The Roles screen's state: the roles, record types and projects, read on open and after each change. In the sample world the source is in memory.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MOCK, tool } from "../../src/real/box";
import { mockSource, rolesSource, type World } from "./source.js";

const call = async (name: string, input: Record<string, unknown> = {}) => {
  try { return { data: await tool<any>(name, input) }; } catch (e) { const x = e as { code?: string; message?: string }; return { error: { code: x.code ?? "error", message: x.message ?? "" } }; }
};

let mock: ReturnType<typeof mockSource> | null = null;
export const source = () => (MOCK ? (mock ??= mockSource()) : rolesSource(call));

export function useRoles() {
  const src = useMemo(source, []);
  const [world, setWorld] = useState<World | null>(null);
  const [error, setError] = useState("");
  const live = useRef(true);
  const load = useCallback(async () => {
    try { const w = await src.read(); if (live.current) { setWorld(w); setError(""); } } catch (e) { if (live.current) { setError((e as { code?: string; message?: string }).message || "Roles could not be read."); setWorld((w) => w ?? { roles: [], types: [], projects: [] }); } }
  }, [src]);
  useEffect(() => { live.current = true; void load(); const off = src.subscribe(() => void load()); return () => { live.current = false; off(); }; }, [load, src]);
  return { world, error, reload: load, src };
}
