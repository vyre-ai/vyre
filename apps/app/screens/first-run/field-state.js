// @ts-check
// The one field the whole welcome flow shares: made once, so it survives every step change. The screens only say how strong it should be and where a ripple goes.
import { INTENSITY, createField, shock } from "./field-core.js";

export const FIELD = createField();

/** The element the field keeps clear around: the current step's content column carries this id. */
export const CONTENT_ID = "onboard-content";

/** Full strength on the welcome screen, calmer on every form. @param {boolean} welcome */
export function setWelcome(welcome) { FIELD.target = welcome ? INTENSITY.welcome : INTENSITY.form; }

/** A ripple at a point of the canvas. @param {number} x @param {number} y @param {number} [power] */
export function ripple(x, y, power) { shock(FIELD, x, y, power); }
