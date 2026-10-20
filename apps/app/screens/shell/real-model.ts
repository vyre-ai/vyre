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
import { spaceName, isPersonal, placeTag } from "../../src/state/space-name.js";

/** The line under a space in the switcher: the person's role there (a Cloud space says so in its own name), or that it is still being set up. */
export const spaceSub = (s: SpaceRow): string => (s.status && s.status !== "done" ? "Setting up" : roleWord(s.role));

/** A space whose creation failed or was cancelled never got a home, so it is not listed (DESIGN-spaces-first.md, "A server step that fails"). */
export const isListed = (s: SpaceRow): boolean => s.status !== "failed" && s.status !== "cancelled";

export function spacesFrom(rows: SpaceRow[]): ShellSpace[] {
  const own = rows.filter(isListed).map((s) => ({ id: s.id, name: spaceName(s), tag: placeTag(s), sub: spaceSub(s), ...(/\.vyre\.run$/i.test(String(s.name)) ? { address: String(s.name) } : {}), ...(isBasicRow(s) ? { basic: true } : {}), ...(!isBasicRow(s) && typeof s.time_zone === "string" && s.time_zone ? { zone: s.time_zone } : {}) }));
  return own;
}

/** The person's name and address, from their identity on this box. A name is capitalised for reading ("devbox" is "Devbox"). */
export function meFrom(i: IdentityRow | null | undefined): Me {
  const addr = i?.name ?? "";
  const raw = i?.label || addr.replace(/\.vyre\.run$/, "") || "";
  const name = raw ? raw[0].toUpperCase() + raw.slice(1) : "You";
  return { name, sub: addr || (i?.pending ? "Setting up" : ""), vyreName: addr };
}

/** The identity to show: the box's own when it has one, else this computer's (a page on a server's address has none on the box, yet the person has a name). */
export const pickIdentity = (box: IdentityRow | null | undefined, host: IdentityRow | null | undefined): IdentityRow | null => (box && (box.name || box.label) ? box : host && (host.name || host.label) ? host : box ?? null);

export const shellFrom = (rows: SpaceRow[], i: IdentityRow | null | undefined): ShellData => ({ me: meFrom(i), spaces: spacesFrom(rows) });

/** The Space the shell opens on when none was used before: the first one (a person is always in exactly one Space). A Space the person used last, still in the list, wins. */
export const startSpace = (d: ShellData, last = ""): string => (last && d.spaces.some((s) => s.id === last) ? last : d.spaces[0]?.id ?? "");

/** The showing space's name for a heading: the one picked, else the only one, else "Space". */
export function showingName(d: ShellData, showing: string): string {
  const real = d.spaces;
  return real.find((s) => s.id === showing)?.name ?? real[0]?.name ?? "Space";
}
