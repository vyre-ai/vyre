// The 5th family, the user's approved addition (28 Sep): a project isn't a being, so its tile is
// a rounded square with a mark and a colour, not a creature or a face - clearly apart from the
// other four (person's circle, assistant's squircle, agent's blob, teammate's character).
//
// Seeded from the project's own stored avatar_seed (never its name - a rename must never reseed
// it), same fingerprint-bytes convention as defaultAvatarOption (ADR 0043 2d/2f): byte 0 picks
// the colour, byte 1 the mark, both mod their own list length. A caller with no stored seed yet
// should fall back to the project's permanent id, per the same rule defaultAvatarOption already
// documents for "no stored pick" - never a name, never a device or box key.
//
// DRAFT tiles (the user's spec, verbatim): every chat not filed under a project gets its own tile
// at once, seeded from the CHAT's id, in a draft style - dashed outline, no fill, same mark and
// colour it would have as a project. When that chat becomes a new project, the project keeps that
// exact seed (draft: false is the only change - same colour, same mark, now solid). When it's
// filed into an existing project, it takes that project's own tile instead, dropping the chat's
// seed entirely - that's a caller-side choice (which seed to pass in), not something this
// function decides.
import { PROJECT_COLORS, featureInkFor, needsRim, RIM } from "./identity.js";

const MARKS = ["square", "triangle", "diamond", "cross", "bars", "grid"];
// Deliberately geometric and inanimate - no eyes, no organic curve - and a different shape set
// from the assistant's own marks (spark/ring/chevron) so a project tile never reads as "an
// assistant in a box" even at a glance. Checked against "No AI-brand lookalikes" (avatar.md): none
// of these six resemble Gemini's sparkle, Claude's starburst, OpenAI's knot, Copilot's shape or
// Perplexity's compass.
function markGlyph(mark, color) {
  const cx = 60, cy = 60;
  switch (mark) {
    case "square": return `<rect x="${cx - 16}" y="${cy - 16}" width="32" height="32" rx="6" fill="${color}"/>`;
    case "triangle": return `<path d="M60 40 L82 78 L38 78 Z" fill="${color}"/>`;
    case "diamond": return `<path d="M60 36 L84 60 L60 84 L36 60 Z" fill="${color}"/>`;
    case "cross": return `<rect x="50" y="34" width="20" height="52" rx="6" fill="${color}"/>
      <rect x="34" y="50" width="52" height="20" rx="6" fill="${color}"/>`;
    case "bars": return `<rect x="36" y="42" width="48" height="12" rx="6" fill="${color}"/>
      <rect x="36" y="66" width="48" height="12" rx="6" fill="${color}"/>`;
    case "grid": return `<circle cx="46" cy="46" r="8" fill="${color}"/><circle cx="74" cy="46" r="8" fill="${color}"/>
      <circle cx="46" cy="74" r="8" fill="${color}"/><circle cx="74" cy="74" r="8" fill="${color}"/>`;
    default: return "";
  }
}

/**
 * A project tile. `seedBytes` is the project's stored avatar_seed (or the chat's id for a draft
 * that hasn't been filed yet) as a byte array - the same shape defaultAvatarOption already takes.
 * `opts.draft` (default false): no fill, a dashed outline instead, same colour and mark. `opts.theme`
 * (default "dark", the repo-wide convention): picks the edge treatment when this tile's colour
 * would otherwise wash into its backdrop, same floor and mechanism as the skin-tone fix
 * (identity.js's rimFor/needsRim - not a second, parallel rule).
 */
function projectTile(seedBytes, { draft = false, theme = "dark", size = 120 } = {}) {
  const color = PROJECT_COLORS[seedBytes[0] % PROJECT_COLORS.length];
  const mark = MARKS[seedBytes[1] % MARKS.length];
  const r = 30; // radius = size/4 in the 120-unit canvas, same rule as the agent/teammate tile

  if (draft) {
    // "Same mark and colours as it would have as a project" (the user's spec, verbatim) - the
    // dashed outline and the mark stay the project's actual colour always, never swapped for the
    // rim ink. What rimFor()'s floor buys a SOLID tile is an added ring inside its fill, not a
    // replaced fill; a draft tile gets the same treatment: a continuous rim-coloured line drawn
    // at the identical geometry sits underneath the dashed one when this colour would otherwise
    // wash into the backdrop, so the boundary reads clearly through the dash gaps even where the
    // true colour alone wouldn't - the colour itself is never hidden.
    const needsHalo = needsRim(color, theme);
    const rim = needsHalo ? RIM[theme] : null;
    const halo = rim
      ? `<rect x="4" y="4" width="112" height="112" rx="${r}" fill="none" stroke="${rim.color}"
          stroke-opacity="${rim.opacity}" stroke-width="5"/>`
      : "";
    // The mark gets the same treatment in miniature: its fill is always the true colour, with a
    // thin rim-coloured edge added only where that colour needs one against this backdrop.
    const markStroke = rim ? ` stroke="${rim.color}" stroke-opacity="${rim.opacity}" stroke-width="1.5"` : "";
    const markSvg = markGlyph(mark, color).replace(/(<(?:rect|path|circle)[^>]*)(\/>)/g, `$1${markStroke}$2`);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}">
      ${halo}
      <rect x="4" y="4" width="112" height="112" rx="${r}" fill="none" stroke="${color}"
        stroke-width="5" stroke-dasharray="14 9"/>
      ${markSvg}
    </svg>`;
  }

  const ink = featureInkFor(color); // the mark's own colour, legible against this tile's fill
  const rim = needsRim(color, theme) ? RIM[theme] : null;
  const rimRing = rim
    ? `<rect x="4.5" y="4.5" width="111" height="111" rx="${r - 0.5}" fill="none" stroke="${rim.color}"
        stroke-opacity="${rim.opacity}" stroke-width="3"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}">
    <rect x="2" y="2" width="116" height="116" rx="${r}" fill="${color}"/>
    ${rimRing}
    ${markGlyph(mark, ink)}
  </svg>`;
}

/** The small badge a teammate wears for its project's colour (avatar.md, the user's approved
 * addition): a filled dot, top-left, out of the way of the existing role badge (bottom-right,
 * round3b/original.js's roleBadge). Returns raw SVG markup, positioned for the 120-unit canvas -
 * `character()` splices it in rather than duplicating the rim/ink logic here. */
function teammateProjectBadge(projectColor, theme = "dark") {
  if (!projectColor) return "";
  const rim = needsRim(projectColor, theme) ? RIM[theme] : null;
  const ring = rim
    ? `<circle cx="20" cy="20" r="8.5" fill="none" stroke="${rim.color}" stroke-opacity="${rim.opacity}" stroke-width="2.5"/>`
    : "";
  return `<circle cx="20" cy="20" r="7" fill="${projectColor}"/>${ring}`;
}

export { projectTile, teammateProjectBadge, MARKS as PROJECT_MARKS };
