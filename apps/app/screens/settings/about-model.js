// @ts-check
// About, pure parts: where the code lives and what the Star button does. Node tests them.

export const REPO_URL = "https://github.com/vyre-ai/vyre";

/**
 * What the Star button does for what github.star.status said (null when it could not be asked).
 * Only a person's own press ever calls `star`: connected and not yet starred stars the repo as them; anything else opens the repo to star there.
 * @param {{ connected?: boolean, starred?: boolean | null } | null | undefined} status
 * @returns {{ label: string, action: "star" | "open" | "none" }}
 */
export function starPlan(status) {
  if (status?.connected && status.starred === true) return { label: "Starred. Thank you", action: "none" };
  if (status?.connected && status.starred === false) return { label: "Star on GitHub", action: "star" };
  return { label: "Star on GitHub", action: "open" };
}

/** The line under the button, so the person knows what a press does. */
export function starNote(/** @type {ReturnType<typeof starPlan>} */ plan) {
  if (plan.action === "star") return "Your connected GitHub account stars the project when you press the button.";
  if (plan.action === "none") return "You have starred Vyre. It helps other people find it.";
  return "Opens the project on GitHub, where you can star it.";
}
