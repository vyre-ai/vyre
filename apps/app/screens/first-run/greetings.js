// @ts-check
// The welcome screen's greeting and the playful line under it: 16 pairs, picked by the hour on the person's own computer, with the hour's own pairs
// counted double, and never the same greeting twice in a row. Words are the owner's, from polish-proposal/onboarding.html (GREET). Pure.

/** @type {Readonly<Record<"morning" | "afternoon" | "evening" | "night" | "any", ReadonlyArray<readonly [string, string]>>>} */
export const GREET = Object.freeze({
  morning: [["Good morning.", "Your agents already had their coffee."], ["Morning.", "Fresh day. Clean inbox. For now."], ["Rise and ship.", "The agents are warmed up."]],
  afternoon: [["Good afternoon.", "Halfway there. Hand off the rest."], ["Afternoon.", "Perfect time to delegate something."]],
  evening: [["Good evening.", "Set it up tonight. Wake up to progress."], ["Evening.", "Your agents don't clock out. You can."]],
  night: [["Up late?", "Your agents are too."], ["Quiet hours.", "Good time to build something."]],
  any: [
    ["Welcome back.", "Everyone's here. Some of them are agents."], ["Hello again.", "Your team missed you. The agents pretended not to."],
    ["Let's get to work.", "Or let your agents. We won't tell."], ["Hey there.", "Less juggling. More done."],
    ["Back at it.", "Your Assistant kept your seat warm."], ["Good to see you.", "Pick up right where you left off."], ["Ready when you are.", "So are your agents."],
  ],
});

/** The part of the day an hour (0 to 23) is in. @param {number} hour */
export function slotOf(hour) {
  return hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 17 ? "afternoon" : hour >= 17 && hour < 22 ? "evening" : "night";
}

/** Every pair the hour may pick from: the hour's own twice, the any-time ones once. @param {number} hour */
export function poolFor(hour) {
  const own = GREET[slotOf(hour)];
  return [...own, ...GREET.any, ...own];
}

/** One pair for this visit, never the greeting `last` shows. `random` is Math.random in the app and a fixed sequence in tests. @param {{ hour: number, last?: string, random?: () => number }} i @returns {readonly [string, string]} */
export function pickGreeting({ hour, last = "", random = Math.random }) {
  const pool = poolFor(hour);
  const fresh = pool.filter((g) => g[0] !== last);
  const from = fresh.length ? fresh : pool;
  return from[Math.min(from.length - 1, Math.floor(random() * from.length))];
}
