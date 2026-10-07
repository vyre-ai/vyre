// Settings sample data (public sample world). The load functions are the reads; a real source replaces them.
import type { AvatarFamily } from "@vyre/ui";

export type AiAccount = { name: string; on: boolean; plan: string; budget: number; used: number; note: string };
export type Assistant = { id: string; name: string; role: string; model: string; family: AvatarFamily; autonomy: string; paused: boolean };

export function loadAccount() {
  return {
    name: "Alex Rivera", vyreName: "alex.vyre.run", line: "Owner of Mine, Admin of Juniper Studio",
    ways: [
      { id: "w1", name: "Alex's iPhone", line: "Passkey, Face ID. Added 12 Aug", here: true, family: "device" as AvatarFamily },
      { id: "w2", name: "Alex's Mac", line: "Passkey, Touch ID. Added 12 Aug", here: false, family: "device" as AvatarFamily },
    ],
    contacts: [{ id: "c1", name: "Chris Park" }, { id: "c2", name: "Mei Tanaka" }],
    code: "R7K4-Q2MX-9HDP-W3NB", newCode: "H3NV-8TQ2-LD5K-X9RM", checked: "3 Sep",
  };
}

export function loadAi(): AiAccount[] {
  return [
    { name: "Claude", on: true, plan: "Max plan", budget: 200, used: 63, note: "" },
    { name: "OpenAI", on: true, plan: "API account", budget: 50, used: 12, note: "" },
    { name: "Grok", on: false, plan: "", budget: 0, used: 0, note: "Connect it to use it as an assistant's model." },
    { name: "OpenRouter", on: false, plan: "", budget: 0, used: 0, note: "One account for many models." },
  ];
}

export function loadAssistants(): Assistant[] {
  return [
    { id: "juno", name: "juno", role: "Your assistant", model: "Claude Sonnet 5.5", family: "assistant", autonomy: "exceptions", paused: false },
    { id: "kit", name: "kit", role: "Assistant of Alex", model: "Claude Sonnet 5.5", family: "teammate", autonomy: "exceptions", paused: false },
    { id: "iris", name: "iris", role: "Assistant of Chris", model: "Codex", family: "assistant", autonomy: "asks", paused: false },
    { id: "rev", name: "rev", role: "Teammate, Juniper Studio", model: "Claude Sonnet 5.5", family: "teammate", autonomy: "asks", paused: false },
  ];
}

export const SEEING: { id: string; name: string; works: string; family: AvatarFamily }[] = [
  { id: "juno", name: "juno", works: "Mine, Juniper Studio", family: "assistant" },
  { id: "kit", name: "kit", works: "Juniper Studio", family: "teammate" },
  { id: "rev", name: "rev", works: "Juniper Studio", family: "teammate" },
];

/** How many records each type holds (for "hidden on all N records"). */
export const RECORD_COUNTS: Record<string, number> = { contact: 124, matter: 38, trip: 6 };

export const VERSION = "0.3";
export const CREDITS = [
  { name: "Twenty", line: "The business-records engine behind Vyre's own gateway. Its server is AGPL-3.0 and its SDK packages are MIT." },
];
