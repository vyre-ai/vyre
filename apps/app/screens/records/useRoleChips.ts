import { useEffect, useState } from "react";
import { allowsMock } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { useSpaces } from "../shell/state";
import { chipsByHolder, summaryChips } from "./roles-model.js";
import { sampleHeld } from "./roles-sample.js";

export type HolderChips = Record<string, { label: string; tone: string; ended: boolean }[]>;
type Kind = { role: string; label: string; color: string };

/** The Space's role kinds (records.roles.summary), kept a minute per Space: the table asks again each time its row count changes, and the kinds change only when a role type is made. */
const KINDS_MS = 60_000;
const kindsKept = new Map<string, { at: number; kinds: Promise<Kind[] | null> }>();
export function roleKinds(space: string): Promise<Kind[] | null> {
  const k = kindsKept.get(space);
  if (k && Date.now() - k.at < KINDS_MS) return k.kinds;
  const kinds = callT<{ roles: Kind[] }>("records.roles.summary", {}).then((s) => (s.error ? null : s.data?.roles ?? []));
  kindsKept.set(space, { at: Date.now(), kinds });
  // a failed answer is not kept
  void kinds.then((v) => { if (v === null) kindsKept.delete(space); });
  return kinds;
}

/** Every holder of one role, page after page (records.holders gives at most 200 at a time), up to 2,000. */
async function holdersOf(role: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 10; pages++) {
    const r = await callT<{ rows: any[]; next_cursor?: string | null }>("records.holders", { role, include_ended: true, limit: 200, ...(cursor ? { cursor } : {}) });
    out.push(...(r.data?.rows ?? []));
    if (r.error || !r.data?.next_cursor) break;
    cursor = r.data.next_cursor;
  }
  return out;
}

/** Every holder's role chips for a People or Companies table: the role kinds (kept a minute) and who holds each, every role at once and every page of each. Null until loaded, and for any other type or a box without the tools. */
export function useRoleChips(type: string, version: string, rows: { urn: string; data?: any }[] = []): HolderChips | null {
  const [chips, setChips] = useState<HolderChips | null>(null);
  const space = useSpaces((s) => s.space) || "home";
  useEffect(() => {
    if (type !== "contact" && type !== "organization") { setChips(null); return; }
    let live = true;
    // The sample world has no roles tools: its people carry the sample roles (roles-sample.js), so the Roles column can be seen.
    if (allowsMock()) {
      const out: HolderChips = {};
      for (const r of rows) { const c = summaryChips(sampleHeld(String(r.data?.name ?? ""), r.urn)); if (c.length) out[r.urn] = c.map((x) => ({ label: x.label, tone: x.tone, ended: x.ended })); }
      setChips(out);
      return;
    }
    void (async () => {
      const kinds = (await roleKinds(space)) ?? [];
      if (!kinds.length) { if (live) setChips(null); return; }
      const got = await Promise.all(kinds.map((k) => holdersOf(k.role).then((r) => [k.role, r] as const)));
      if (live) setChips(chipsByHolder(kinds, Object.fromEntries(got)));
    })();
    return () => { live = false; };
  }, [type, version, rows.length, space]);
  return chips;
}
