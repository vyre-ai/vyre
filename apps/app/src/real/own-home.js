// @ts-check
// The words a member gets when she tries to use a Space assistant or a teammate from the Assistants screen: the gate's own (core/switchboard/asker-account.js, core/team/index.js); nothing is started.
// (The "yours, not the team's" notice that lived here is replaced by the tag on everything: src/state/space-name.js placeTag, src/real/PlaceTag.tsx.)

/** @param {{ name: string, kind?: string }} who @param {boolean} onTeam */
export function useRefusal(who, onTeam) {
  if (who.kind === "teammate") return onTeam ? `${who.name}'s sign-in cannot be used for a teammate's request yet. The owner can run it for you. Nothing was started.` : "You are not on this project's team. Ask the project's owner to add you, then ask again. Nothing was queued.";
  return `${who.name} has no AI sign-in picked for it, and the owner's is not used for your request. Ask the owner to pick one for it. Nothing was started.`;
}
