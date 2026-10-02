// The import screen's words and arithmetic, with no page around them, so a test can check them.
// Everything here turns the local helper's answers into plain text; none of it is markup.

export const AGENTS = { "claude-code": "Claude Code", codex: "Codex", grok: "Grok", "gemini-cli": "Gemini" };
export const LOOKED_IN = "Claude Code, Codex, Grok and Gemini";

export const n = (c, one, many) => `${c} ${c === 1 ? one : many}`;
export const size = (b) => (b >= 1048576 ? `${Math.round(b / 1048576)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
const day = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
export const range = (a, b) => (!a || !b ? "" : day(a) === day(b) ? day(a) : `${day(a)} to ${day(b)}`);
export const sub = (o) => [n(o.sessions, "session", "sessions"), size(o.bytes), range(o.from, o.to)].filter(Boolean).join(" · ");

/** A folder with no known cwd cannot be chosen by folder, so it is listed but not offered. */
export const choosable = (f) => typeof f.cwd === "string" && f.cwd.length > 0;

/** The folders to ask a plan for: every ticked, choosable folder. */
export function includeOf(folders, ticked) {
  return folders.filter((x) => ticked.has(x.id) && choosable(x.f)).map((x) => x.f.cwd);
}

/** The two speeds, worded from the plan's own estimate. */
export function paceText(pace) {
  const h = pace?.fast?.hours, d = pace?.gentle?.days;
  return {
    fast: `Fast: understood in about ${n(h || 1, "hour", "hours")}. Uses more of your Claude plan today.`,
    gentle: `Gentle: understood over about ${n(d || 1, "day", "days")}. Barely touches your Claude plan.`,
  };
}

export const KEEPS = (days) => (Number.isFinite(days) ? `Claude Code keeps sessions for ${n(days, "day", "days")}. Import now so they stay in Vyre.` : "");

/** What the plan will do, in one line the person confirms by pressing Send. */
export function planLine(plan, mode) {
  if (!plan || !plan.sessions) return "Nothing is chosen yet.";
  const what = `${n(plan.sessions, "session", "sessions")} (${size(plan.bytes)}) from ${n(plan.folders.length, "project", "projects")}`;
  return mode === "sync" ? `Send ${what} to your Vyre server now, and keep sending new ones.` : `Send ${what} to your Vyre server once.`;
}

export const canSend = (plan, mode, pace) => Boolean(plan && plan.sessions > 0 && (mode === "once" || mode === "sync") && (pace === "fast" || pace === "gentle"));

/** Upload progress from import.status's `upload`, in words. */
export function progressText(u) {
  if (!u) return "";
  const left = u.failed ? ` ${n(u.failed, "session", "sessions")} could not be read.` : "";
  const held = u.quarantined ? ` ${n(u.quarantined, "session", "sessions")} held back because of a secret in it.` : "";
  if (u.state === "sending") return `Sending: ${u.done} of ${u.total}.${left}${held}`;
  if (u.state === "stopped") return `Stopped. What was already sent (${n(u.done, "session", "sessions")}) stays on your server.${left}${held}`;
  return `Sent ${n(u.done, "session", "sessions")} to your server.${left}${held}`;
}

/** The local helper's own state, in words, while it is being got ready. */
export function coreText(st) {
  if (!st) return "Looking on this PC…";
  if (st.state === "installing") return `${st.message || "Getting Vyre's local helper"}. This is a one-time download.`;
  if (st.state === "starting") return "Starting Vyre's local helper…";
  return "Looking on this PC…";
}

/** Only the helper's own plain-word errors reach the screen, trimmed. */
export const plainError = (e) => {
  const t = String(e || "").replace(/[\u0000-\u001f]/g, " ").trim();
  // The core words its link errors for a Mac; this is a PC.
  if (/not paired with a box/i.test(t)) return "This PC is not linked to your Vyre server yet, so nothing can be sent. Nothing was sent.";
  return t.slice(0, 300) || "That did not finish.";
};
