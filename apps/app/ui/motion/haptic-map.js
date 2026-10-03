// Which haptic each moment uses. Pure: haptics.ts maps these names to expo-haptics calls (and does nothing on the web).
/** @type {Record<"approve" | "stage" | "selection" | "warn", { kind: "notification" | "impact" | "selection", style: string }>} */
export const HAPTICS = {
  approve: { kind: "notification", style: "Success" },
  stage: { kind: "impact", style: "Medium" },
  selection: { kind: "selection", style: "" },
  warn: { kind: "notification", style: "Warning" },
};
export const HAPTIC_NAMES = Object.keys(HAPTICS);
