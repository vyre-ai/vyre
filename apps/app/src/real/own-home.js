// @ts-check
// Screens that show HER OWN home while a team she joined is showing (the member map routes only the team's own work through the team's door: team/0.3.3/RC2-NOTES.md, "What a team MEMBER sees in the app").
// Each says so plainly and names what the team's side holds for her, one tap away. The words per screen live here, once; where the server has no rule for what a member may see (team/0.3.4/MEMBER-SPACE-plan.md, Q1 to Q16) the
// team's side says nothing is shared with her yet and who to ask. Pure: the component (OwnHomeNotice.tsx) only draws these.

/** @typedef {{ title: string, body: string, team: string, href?: string }} Note */

export const YOURS = "This is on your own computer, not the team's. Nothing here is shared with the team.";
const ASK = "Nothing is shared with you here yet. Ask the owner.";

/** The screens that show her own home. @type {Readonly<Record<string, Note>>} */
export const NOTES = Object.freeze({
  vault: { title: "Your own vault", body: YOURS, team: `The team's vault: ${ASK} A member sees an item's name and uses it only when the owner shares it with her or her project; never the secret itself.` },
  assistants: { title: "Your own assistants", body: YOURS, team: "The team's assistants and teammates are listed below, read-only. To use one you need an AI sign-in of your own on the team's server (Settings, AI accounts)." },
  connections: { title: "Your own connections", body: YOURS, team: `The team's connections: ${ASK}` },
  devices: { title: "Your own devices", body: YOURS, team: "Your devices stay yours. The team's computers are the owner's to show you." },
  publish: { title: "Your own sites", body: YOURS, team: `The team's sites: ${ASK}` },
  planner: { title: "Your own planner", body: YOURS, team: "The team's tasks for you are in Now. Your reminders and notes stay yours." },
  memory: { title: "Your own memory", body: YOURS, team: `The team's memory: ${ASK}` },
  drive: { title: "Your own files", body: YOURS, team: "A project's files are in the project, under Files.", href: "/u/projects" },
  find: { title: "Searching your own computer", body: YOURS, team: "The team's side (project and record names) is in Projects and Records." },
  providers: { title: "Your own AI accounts and spend", body: YOURS, team: "Your AI sign-ins on the team's server are under AI accounts above. The team's allowance is the owner's." },
});

/** The note for a screen, or null for a screen that is not on the list. @param {string} screen @returns {Note | null} */
export const noteFor = (screen) => (Object.hasOwn(NOTES, screen) ? NOTES[screen] : null);

/** The words a member gets when she tries to use a Space assistant or a teammate from here: the gate's own (core/switchboard/asker-account.js, core/team/index.js), nothing is started. @param {{ name: string, kind?: string }} who @param {boolean} onTeam */
export function useRefusal(who, onTeam) {
  if (who.kind === "teammate") return onTeam ? `${who.name}'s sign-in cannot be used for a teammate's request yet. The owner can run it for you. Nothing was started.` : "You are not on this project's team. Ask the project's owner to add you, then ask again. Nothing was queued.";
  return `${who.name} has no AI sign-in picked for it, and the owner's is not used for your request. Ask the owner to pick one for it. Nothing was started.`;
}
