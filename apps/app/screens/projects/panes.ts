// What a project page shows (R031-14, 15), pure. A free-flow project opens on its chats, with Files and Memory beside them; a project that started from a template opens on its stages and tasks first.
// On a wide window the panes sit side by side instead of behind tabs: two from 1100 points, three from 1280 (a laptop shows all of Stages, Chats and Files).
export type PaneId = "stages" | "chats" | "files" | "memory" | "timeline" | "team";

export const WIDE = 1100;
export const WIDER = 1280;

/** The words on the header button that starts a chat about the project: short on a phone, where a longer label cuts the project's own name. */
export const chatLabel = (width: number): string => (width < WIDE ? "Chat" : "Chat about this");

export const LABEL: Record<PaneId, string> = { stages: "Stages", chats: "Chats", files: "Files", memory: "Memory", timeline: "Timeline", team: "Team" };

/** A project started from a template carries its pinned stages (the work module writes `template_snapshot`); every other project is free-flow. */
export const isTemplateProject = (data: Record<string, unknown> | undefined | null): boolean => Boolean(data && typeof data.template_snapshot === "string" && data.template_snapshot);

/** The tabs of a project page, first tab first: the one it opens on. */
export function tabsFor(data: Record<string, unknown> | undefined | null): [PaneId, string][] {
  const order: PaneId[] = isTemplateProject(data) ? ["stages", "chats", "files", "memory", "timeline", "team"] : ["chats", "files", "memory", "timeline", "team"];
  // a template can say which page its projects open on (`opens_on`, pinned in the snapshot): that tab goes first
  const want = opensOn(data);
  if (want && order.includes(want)) order.splice(order.indexOf(want), 1), order.unshift(want);
  return order.map((p) => [p, LABEL[p]]);
}

/** The page the project's template chose to open on, from its pinned snapshot; null when it chose none or the text is not readable. */
export function opensOn(data: Record<string, unknown> | undefined | null): PaneId | null {
  if (!isTemplateProject(data)) return null;
  try { const v = JSON.parse(String(data!.template_snapshot)).opens_on; return typeof v === "string" && v in LABEL ? (v as PaneId) : null; } catch { return null; }
}
export const firstTab = (data: Record<string, unknown> | undefined | null): PaneId => tabsFor(data)[0][0];

/**
 * The panes on screen at a width, left to right. Narrow: just the chosen tab. Wide: the project's first pane and its chats, with the files too when there is room; the timeline and the team are tabs only.
 * The tab chosen is kept in the set so what the person opened is never hidden by resizing.
 */
export function panesAt(width: number, tab: PaneId, data: Record<string, unknown> | undefined | null): PaneId[] {
  if (width < WIDE) return [tab];
  const base: PaneId[] = isTemplateProject(data) ? ["stages", "chats", "files"] : ["chats", "files", "memory"];
  const want = width >= WIDER ? base : base.slice(0, 2);
  if (tab === "team" || tab === "timeline") return [tab];
  return want.includes(tab) ? want : [...want.slice(0, want.length - 1), tab];
}
