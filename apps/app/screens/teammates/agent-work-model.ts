// The "Agent work" section of a project's Team tab (G08): which AI account agent teammates work on when nobody is watching, the daily limit on turns they start by themselves, and how often the project
// lead reports. Pure words and options; the calls are in AgentWork.tsx. Only the viewer's own accounts are ever listed, and a pick is the viewer's own.
import { accountsOf, type Account } from "../settings/accounts-model.ts";

export const TITLE = "Agent work";
export type Setting = { account: string | null; person: string | null; dailyLimit: number | null; reportHours: number | null; agentPick: boolean };

/** agents.work.setting's answer, reduced to what is drawn. @param d the tool's data */
export function settingOf(d: any): Setting {
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return { account: typeof d?.account === "string" && d.account ? d.account : null, person: typeof d?.person === "string" && d.person ? d.person : null, dailyLimit: n(d?.daily_limit), reportHours: n(d?.report_hours), agentPick: d?.agent_pick === true };
}

/** The viewer's own Claude accounts that can run work: signed in, not waiting on a step. (agents.work runs on the Claude provider.) */
export function usable(list: unknown): Account[] {
  return accountsOf(list).filter((a) => a.provider === "claude" && !a.pending && !a.synthetic);
}

/** The choices of one account picker: "default" first, then each account of the viewer's. The value is the account id, "" for the default. */
export function accountOptions(accounts: Account[], defaultLabel = "My default account"): [string, string][] {
  const def = accounts.find((a) => a.isDefault);
  return [["", def ? `${defaultLabel} (${def.label})` : defaultLabel], ...accounts.map((a): [string, string] => [a.id, a.label])];
}

/** The line under the project's account picker. */
export function accountLine(set: Setting, accounts: Account[]): string {
  if (!set.account) return accounts.length ? "Agents work on the account of the person who gave them the task. Pick one to use for the whole project instead." : "Agents work on the account of the person who gave them the task. Add an AI account under Settings to choose one.";
  const a = accounts.find((x) => x.id === set.account);
  return a ? `Agents work on ${a.label} when the person who gave them the task can use it.` : "The account picked for this project is not one of yours, so you cannot change what it is. Pick one of yours to replace it.";
}

export const LIMITS = [25, 50, 100, 250, 500, 1000] as const;
export const DEFAULT_LIMIT = 100;
export const limitOptions = (current: number | null): [string, string][] => {
  const all = new Set<number>([...LIMITS, current ?? DEFAULT_LIMIT]);
  return [...all].sort((a, b) => a - b).map((n): [string, string] => [String(n), `${n} turns a day`]);
};
export const limitLine = "Agents stop starting work on their own after this many turns in a day. The rest wait, and start again the next day.";

export const REPORTS: [string, string][] = [["24", "Every day"], ["12", "Twice a day"], ["168", "Every week"], ["0", "Off"]];
export const reportValue = (hours: number | null): string => String(hours ?? 24);
export const reportLine = (hours: number | null): string => (hours === 0 ? "The project lead writes no regular report." : `The project lead writes a short report ${hours === 168 ? "every week" : hours === 12 ? "twice a day" : "every day"} and says what is stuck.`);

/** The one line shown when a project starts from a template or a Flow and no account has been picked for its agents. */
export const startLine = (accountLabel: string | null): string =>
  `Agents on this project will work on ${accountLabel ? accountLabel : "the account of the person who gives them each task"}. Change it under Team, ${TITLE}.`;

/** A refusal in words, with the next step. */
export function refusal(code: string | undefined, message: string): string {
  if (code === "not_found") return "That is not one of your AI accounts. Pick one from the list.";
  if (code === "denied") return "Choosing the account agents work on is a person's. Sign in as yourself, then try again.";
  if (code === "presence_required" || code === "presence_denied") return "Confirm on your phone, then try again.";
  return message || "That did not save. Try again.";
}
