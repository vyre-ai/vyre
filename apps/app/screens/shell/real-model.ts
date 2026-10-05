// The pure half of the shell on the real box: spaces.list and spaces.identity.status as the space switcher's rows and the person's line.
import { isBasicRow } from "./basic.js";
import type { ShellSpace } from "@vyre/ui";

export type SpaceRow = { id: string; name: string; label?: string; displayName?: string; status?: string; role?: string; tier?: "basic" | "cloud"; time_zone?: string | null; who?: string; setup?: { who?: string; picks?: { who?: string } } | null };
export type IdentityRow = { exists?: boolean; name?: string; label?: string; pending?: boolean };
export type Me = { name: string; sub: string; vyreName: string };
export type ShellData = { me: Me; spaces: ShellSpace[] };

const ROLE: Record<string, string> = { owner: "Owner", admin: "Admin", manager: "Manager", member: "Member", temp: "Guest" };
export const roleWord = (r?: string): string => (r && ROLE[r]) || "Member";

export { spaceName, isPersonal } from "../../src/state/space-name.js";
import { spaceName, isPersonal } from "../../src/state/space-name.js";

/** The line under a space in the switcher: the person's role there (a team space also carries its small "Cloud" tag), or that it is still being set up. */
export const spaceSub = (s: SpaceRow): string => (s.status && s.status !== "done" ? "Setting up" : [!isPersonal(s) && s.tier === "cloud" ? "Cloud" : "", roleWord(s.role)].filter(Boolean).join(" · "));

export const ALL: ShellSpace = { id: "all", name: "All spaces", sub: "One list, everything" };

/** The switcher's rows: All spaces first (only when there is more than one), then each space the person belongs to. */
/** A space whose creation failed or was cancelled never got a home, so it is not listed (DESIGN-spaces-first.md, "A server step that fails"). */
export const isListed = (s: SpaceRow): boolean => s.status !== "failed" && s.status !== "cancelled";

export function spacesFrom(rows: SpaceRow[]): ShellSpace[] {
  const own = rows.filter(isListed).map((s) => ({ id: s.id, name: spaceName(s), sub: spaceSub(s), ...(isBasicRow(s) ? { basic: true } : {}), ...(!isBasicRow(s) && typeof s.time_zone === "string" && s.time_zone ? { zone: s.time_zone } : {}) }));
  return own.length > 1 ? [ALL, ...own] : own.length ? own : [ALL];
}

/** The person's name and address, from their identity on this box. A name is capitalised for reading ("devbox" is "Devbox"). */
export function meFrom(i: IdentityRow | null | undefined): Me {
  const addr = i?.name ?? "";
  const raw = i?.label || addr.replace(/\.vyre\.run$/, "") || "";
  const name = raw ? raw[0].toUpperCase() + raw.slice(1) : "You";
  return { name, sub: addr || (i?.pending ? "Setting up" : ""), vyreName: addr };
}

export const shellFrom = (rows: SpaceRow[], i: IdentityRow | null | undefined): ShellData => ({ me: meFrom(i), spaces: spacesFrom(rows) });

/** The space the shell opens on: All spaces when there is more than one, else the only space. */
export const startSpace = (d: ShellData): string => d.spaces[0]?.id ?? "all";

/** The showing space's name for a heading: the one picked, else the only one, else "Space". */
export function showingName(d: ShellData, showing: string): string {
  const real = d.spaces.filter((s) => s.id !== "all");
  return real.find((s) => s.id === showing)?.name ?? real[0]?.name ?? "Space";
}
