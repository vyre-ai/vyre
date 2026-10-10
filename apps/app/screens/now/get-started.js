// @ts-check
// "Get started" on Now for a box that is new: when there is both a phone to add and an assistant to make, one quiet card holds the two as steps, in the order a person does them, instead of an amber banner
// and a full-width card stacked above the greeting. With only one of the two the screen keeps showing that one as before. Pure, so Node tests it.
import { GAP } from "../install/first-run.js";

/** @typedef {{ title: string, line: string, action: string, route: string }} Step */

/**
 * The card's steps, or null when there is nothing to combine.
 * @param {{ title?: string, line?: string, action: string, route: string } | null} gap what is missing on this device (first-run.js gapOf)
 * @param {{ title: string, body: string, action: string, href: string } | null} assistant the Create your assistant copy, when this person should see it
 * @returns {{ title: string, steps: Step[] } | null}
 */
export function getStarted(gap, assistant) {
  // only the phone gap on a Mac is a step to do here: a device with no Vyre to talk to cannot make an assistant, and a setup banner already says everything in one place
  if (!gap || !assistant || gap.route !== GAP.mac.route) return null;
  return {
    title: "Get started",
    steps: [
      { title: "Add your phone", line: "Sends and new devices wait for a yes from it.", action: gap.action, route: gap.route },
      { title: assistant.title, line: assistant.body, action: assistant.action, route: assistant.href },
    ],
  };
}
