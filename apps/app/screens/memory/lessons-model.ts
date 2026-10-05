// The pure half of Lessons on a real vyred: what learn.lessons, learn.stats and learn.skills answer, as the lines the screen shows.
// The same wording as the Deck's memory-data.js, so a lesson reads the same on both.

export type Check = { kind?: string; label?: string } | null;
export type Lesson = { id: number | string; rule: string; when?: string | null; level: string; status: string; scope?: unknown; check?: Check; applied?: number; caught?: number; broken?: number;
  source?: { kind?: string; session?: string; seq?: number; text?: string } | null; created?: number; updated?: number };
export type Skill = { id: number | string; name?: string; description?: string; status?: string; steps?: unknown[]; sessions?: number };
type StatRow = { id?: number | string; lesson?: number | string; verdict?: string; effect?: string; turns?: number; measured?: number; before?: number; after?: number };

export const LEVELS = ["remind", "ask", "block"];
/** The levels a Relax can lower to: the ones under the current one. */
export const lowerLevels = (level: string): string[] => LEVELS.slice(0, Math.max(0, LEVELS.indexOf(level)));

/** A list answer in whichever shape it comes: an array, or an object holding `lessons` or `skills`. */
export const listOf = <T,>(d: unknown): T[] => {
  const x = d as { lessons?: T[]; skills?: T[] } | T[] | null | undefined;
  return Array.isArray(x) ? x : Array.isArray(x?.lessons) ? x.lessons : Array.isArray(x?.skills) ? x.skills : [];
};

/** Proposed, active and retired; dormant counts as active. */
export function groupLessons(list: Lesson[]): { proposed: Lesson[]; active: Lesson[]; retired: Lesson[] } {
  const g = { proposed: [] as Lesson[], active: [] as Lesson[], retired: [] as Lesson[] };
  for (const l of list) (l.status === "proposed" ? g.proposed : l.status === "retired" ? g.retired : g.active).push(l);
  return g;
}

/** Where a lesson applies, in words. */
export function scopeWords(scope: unknown, names: Map<string, string> = new Map()): string {
  if (!scope || scope === "all") return "Everywhere";
  const o = scope as { project?: string; agent?: string };
  if (typeof scope === "object" && o.project) return `Only in ${names.get(o.project) || o.project}`;
  if (typeof scope === "object" && o.agent) return `Only for ${o.agent}`;
  return String(scope);
}

export const countsLine = (l: Lesson): string => `applied ${l.applied || 0}, caught ${l.caught || 0}, broken ${l.broken || 0}`;

const CHECK: Record<string, string> = { text: "text check", touched: "file check", before: "order check", tool: "tool check", path: "path check", after: "after check" };
/** What a check does, as a tag; null for a lesson with none. */
export const checkWords = (check: Check | undefined): string | null => (check ? CHECK[check.kind ?? ""] ?? "check" : null);

export const SOURCE: Record<string, string> = {
  prompt: "your correction", correction: "your correction", remember: "a lesson you wrote", edited: "your edit to a draft", "draft-edit": "your edit to a draft",
  denied: "a call you denied", declined: "a call you declined", reverted: "a change you reverted", repeated: "a correction you repeated", corrected: "a fact you corrected",
  "test-fix": "a test you fixed", user: "you",
};

/** learn.stats's verdict for one lesson, from whichever shape it answers in. Null when there is none. */
export function verdictOf(stats: unknown, id: number | string): { verdict: string; text: string } | null {
  if (!stats) return null;
  const s0 = stats as { lessons?: StatRow[] } & Record<string, StatRow>;
  const rows = Array.isArray(stats) ? (stats as StatRow[]) : Array.isArray(s0.lessons) ? s0.lessons : null;
  const s = rows ? rows.find((r) => String(r.id ?? r.lesson) === String(id)) : s0[String(id)];
  const v = s && (s.verdict || s.effect);
  if (!s || !v) return null;
  const turns = s.turns ?? s.measured;
  const fmt = (n: number) => (Math.round(Number(n) * 10) / 10).toString();
  const rate = s.before !== undefined && s.after !== undefined ? `, ${fmt(s.before)} to ${fmt(s.after)} per 100 turns` : "";
  const text = v === "working" ? `Working${rate}` : v === "not working" || v === "not_working" ? `Not working${rate}` : `Measuring${turns !== undefined ? `, ${turns} turns so far` : ""}`;
  return { verdict: v === "not_working" ? "not working" : v, text };
}

/** A refusal as a line a person can act on. Accept, Retire, Relax and Install need the person; a failed proof says so. */
export function refusalWords(e: { code?: string; message?: string }, tool: string): string {
  if (e.code === "no_such_tool") return `This needs a newer learning module (${tool} is not there yet).`;
  if (e.code === "presence_required" || e.code === "needs_presence") return e.message || "This needs you in person.";
  return e.message || "That did not go through.";
}

/** Why an Edit was refused when it would loosen the lesson: loosening is Relax's job and needs the person. */
export const editRefusal = (e: { code?: string; message?: string }): string =>
  e.code === "presence_required" || /relax/i.test(String(e.message)) ? `That would loosen the lesson, so it needs Relax, which needs you in person. ${e.message ?? ""}`.trim() : e.message || "That did not save.";

/** The lines for a skill: "4 steps, seen clean in 3 sessions". */
export function skillLine(k: Skill): string {
  const n = Array.isArray(k.steps) ? k.steps.length : 0;
  return [n ? `${n} ${n === 1 ? "step" : "steps"}` : "", k.sessions ? `seen clean in ${k.sessions} ${k.sessions === 1 ? "session" : "sessions"}` : ""].filter(Boolean).join(", ");
}
