// @ts-check
// Who is staff: an owner or an admin. The one test every place that asks it calls (the kernel's check that the maker of an agent that approves another agent's work still holds the role, the agents module's
// "made by staff" flag), so the two cannot drift apart.

/** @param {string | null | undefined} role */
export const isStaffRole = (role) => role === "owner" || role === "admin";
