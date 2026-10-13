// @ts-check
// off: the first-party modules a release ships but leaves off, so the code stays and one line brings it back.
// core/daemon/main.js (the real vyred) passes this list to start() as `modulesOff`; start() adds it to the
// registry's `disable` list, the same one a Basic device uses for the planner. Tests that boot a daemon in-process
// do not pass it, so a module listed here is still loadable and tested directly.
// The planner (reminders, alarms, timers, to-dos, notes, the agenda) is off from 0.3.3-rc.4: "disable the planner
// from this next release for now to further simplify things. We can bring in planner later." To bring it back,
// empty this list (and show its Settings row in apps/app/screens/settings/logic.js).

/** @type {readonly string[]} */
export const MODULES_OFF = Object.freeze(["planner"]);
