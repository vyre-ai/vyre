// @ts-check
// A person's level on one project (team/0.3.4/ROLES-proposal.html section 3): lead, contributor or viewer. It is stored on the person's team-member row (`level`); a row with none is a contributor, so a seat
// made before levels existed behaves as it did. A level only NARROWS what the person's Space role allows and never widens it: a viewer writes nothing in the project whatever the Space role, and a lead
// manages the project's team only when the Space role is member or above (a Guest who is "lead" can do nothing a Guest cannot).

export const SEAT_LEVELS = Object.freeze(["lead", "contributor", "viewer"]);

/** The level a team-member row's data carries; anything else reads as contributor. @param {any} data */
export const levelOfSeat = data => (data && SEAT_LEVELS.includes(data.level) ? String(data.level) : "contributor");

/** What a viewer is told, with the next step. */
export const VIEWER_WORDS = "You have read-only access to this project (viewer). Ask the project's owner or a lead to make you a contributor.";
