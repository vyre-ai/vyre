import { useEffect, useState } from "react";
import { callT } from "../../src/real/call-tool";
import { chipsByHolder } from "./roles-model.js";

export type HolderChips = Record<string, { label: string; tone: string; ended: boolean }[]>;

/** Every holder's role chips for a People or Companies table: one call for the role kinds (records.roles.summary) and one for who holds each (records.holders). Null until loaded, and for any other type or a box without the tools. */
export function useRoleChips(type: string, version: string): HolderChips | null {
  const [chips, setChips] = useState<HolderChips | null>(null);
  useEffect(() => {
    if (type !== "contact" && type !== "organization") { setChips(null); return; }
    let live = true;
    void (async () => {
      const s = await callT<{ roles: { role: string; label: string; color: string }[] }>("records.roles.summary", {});
      const kinds = s.data?.roles ?? [];
      if (!kinds.length) { if (live) setChips(null); return; }
      const got = await Promise.all(kinds.map((k) => callT<{ rows: any[] }>("records.holders", { role: k.role, include_ended: true, limit: 200 }).then((r) => [k.role, r.data?.rows ?? []] as const)));
      if (live) setChips(chipsByHolder(kinds, Object.fromEntries(got)));
    })();
    return () => { live = false; };
  }, [type, version]);
  return chips;
}
