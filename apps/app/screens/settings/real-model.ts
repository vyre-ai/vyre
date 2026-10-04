// The pure half of Settings on the real box: update.status and push.settings answers as the lines the screens show.

export type UpdateStatus = { current: string; available: string | null; channel: string; notes: string[]; checkedAt: number | null; auto: string; error: string | null; how: string; command?: string; canApply: boolean; pending: boolean; run?: unknown };
export type PushSettings = { quiet: { start: string; end: string; timezone?: string } | null; kinds: Record<string, boolean>; planner_label?: boolean; quiet_now?: boolean };
export type PushDevice = { device: string; label: string; service: string; at: number; last_ok: number | null; fails: number };

/** The headline of Updates. */
export function updateLine(s: UpdateStatus): string {
  if (s.error) return `The last look failed: ${s.error}`;
  if (s.pending) return "An update is being installed.";
  return s.available ? `Vyre ${s.available} is out. You are on ${s.current}.` : "You are up to date.";
}
/** "Checked 3 minutes ago", never a made-up time. */
export function checkedLine(at: number | null, now: number): string {
  if (!at) return "Not checked yet.";
  const m = Math.max(0, Math.round((now - at) / 60000));
  return m < 1 ? "Checked just now." : m < 60 ? `Checked ${m} ${m === 1 ? "minute" : "minutes"} ago.` : m < 1440 ? `Checked ${Math.round(m / 60)} ${Math.round(m / 60) === 1 ? "hour" : "hours"} ago.` : `Checked ${Math.round(m / 1440)} days ago.`;
}
/** How the person updates here: a button when the box takes the request, otherwise the one command to run. */
export function howLine(s: UpdateStatus): string {
  if (s.canApply) return "";
  return s.command ? `To update, run ${s.command} on your home.` : "Update from the app that installed Vyre.";
}
export const autoLine = (auto: string): string => (auto === "notify" ? "Vyre tells you when an update is out. It never installs one by itself." : auto === "off" ? "Update checks are off." : auto === "install" ? "Vyre installs signed updates by itself." : `Update mode: ${auto}.`);

/** The kinds a person can switch, in words. `notice` says a guard was loosened as asked, and nobody switches it off. */
export const KIND_ROWS: [string, string, string][] = [
  ["ask", "Something needs you", "Asks, approvals and pairing requests."],
  ["draft", "A draft is ready", "A draft waits for your yes."],
  ["watch", "A watcher found something", "What your watchers were set to look for."],
  ["planner", "Your day", "Things the planner puts in front of you."],
  ["goal", "A goal moved", "Progress and blocks on a goal."],
  ["proactive", "Suggestions", "Things an assistant noticed on its own."],
  ["lesson", "What Vyre learned", "A lesson was kept. Off until you turn it on."],
];

/** Quiet hours as a line: "10 pm to 7 am" from "22:00" and "07:00". */
export function quietLine(q: PushSettings["quiet"]): string {
  if (!q) return "No quiet hours.";
  const t = (s: string) => { const [h, m] = s.split(":").map(Number); const hh = h % 12 || 12; return `${hh}${m ? ":" + String(m).padStart(2, "0") : ""} ${h < 12 ? "am" : "pm"}`; };
  return `${t(q.start)} to ${t(q.end)}${q.timezone ? `, ${q.timezone}` : ""}`;
}
export const QUIET_DEFAULT = { start: "22:00", end: "07:00" };
