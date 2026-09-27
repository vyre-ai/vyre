// @ts-check
// A hidden command: not in `vyre help`, not in docs, found only by typing it. No network, no
// sound, never touches a real session. See core/cli/delight.js for the line and its gate.

import { out } from "../style.js";
import { EXIT } from "../kit.js";
import { highFiveLine } from "../delight.js";

/** @type {import("../index.js").Command} */
export default {
  name: "high-five",
  summary: "hidden",
  hidden: true,
  secret: true,
  async run() {
    out(highFiveLine());
    return EXIT.OK;
  },
};
