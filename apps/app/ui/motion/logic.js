// The pure half of the motion kit: values derived from tokens.v2.motion, no React and no native modules, so node:test can run it.
// The components in this folder pass `tokens.v2.motion` in; nothing here keeps a number of its own.

/**
 * A reanimated spring config from a token spring. The tokens give a damping RATIO (1 is critically damped) and a stiffness; reanimated wants a damping
 * coefficient, which for mass 1 is 2 * ratio * sqrt(stiffness). A ratio of 1 or more must not overshoot, so it clamps.
 * @param {{ spring: Record<string, Record<string, { damping: number, stiffness: number }>> }} motion tokens.v2.motion
 * @param {"spatial" | "effects"} kind spatial moves things (position, size, scale); effects changes colour and opacity
 * @param {"fast" | "default" | "slow"} speed
 */
export function springConfig(motion, kind = "spatial", speed = "default") {
  const s = motion.spring?.[kind]?.[speed];
  if (!s) throw new Error(`no spring ${kind}.${speed} in tokens.v2.motion`);
  return { mass: 1, stiffness: s.stiffness, damping: 2 * s.damping * Math.sqrt(s.stiffness), overshootClamping: s.damping >= 1 };
}

/** Every spring the kit uses, resolved once. */
export function springs(motion) {
  const out = {};
  for (const kind of Object.keys(motion.spring)) for (const speed of Object.keys(motion.spring[kind])) out[`${kind}.${speed}`] = springConfig(motion, kind, speed);
  return out;
}

/**
 * Reduced motion is on when the person turned it on (Appearance) OR the system asks for it. Either one is enough; neither can turn the other off,
 * because someone who set it in the OS must not have to set it again in Vyre.
 * @param {{ person?: boolean | null, os?: boolean | null }} src
 */
export function resolveReducedMotion({ person, os } = {}) {
  return person === true || os === true;
}

/** The delay in ms for the item at `index` of a staggered entrance: one step each, and nothing past the max (a long list does not wait). */
export function staggerDelay(motion, index) {
  const { step, max } = motion.stagger;
  const i = Math.max(0, Math.min(Math.floor(index) || 0, max));
  return i * step;
}

/** How far an entering item travels (px) and how small it starts. Reduced motion: no travel, no scale; the fade stays (a state change still shows). */
export function entrance(reduced) {
  return reduced ? { dy: 0, scale: 1 } : { dy: 8, scale: 0.98 };
}

/** The scale a pressed control springs to. Reduced motion keeps 1 (the pressed look is a colour, not a movement). */
export function pressScale(reduced, depth = 0.97) {
  return reduced ? 1 : depth;
}

/**
 * A loading skeleton: a steady block that shimmers. Reduced motion stops the shine and leaves the block still.
 * @returns {{ shimmer: boolean, period: number }}
 */
export function skeletonPlan(motion, reduced) {
  return { shimmer: !reduced, period: motion.duration.nod * 3 };
}

/** A hold button's fill time in ms (tokens.v2.motion.hold). Reduced motion keeps the hold: it is a safety, not decoration. */
export function holdDuration(motion) {
  return motion.hold;
}

// Swipe actions ------------------------------------------------------------------------------------------------------------------------------------

const SWIPE = {
  done: { id: "done", label: "Mark done", icon: "check", tone: "ok", side: "leading", haptic: "approve" },
  reassign: { id: "reassign", label: "Reassign", icon: "agents", tone: "accent", side: "trailing", haptic: "selection" },
  open: { id: "open", label: "Open", icon: "chev-r", tone: "plain", side: "trailing", haptic: "selection" },
};

/**
 * Which swipe actions a task card offers, from the button ids it already has. Swiping right reveals Mark done; swiping left reveals Reassign and Open.
 * An action the card does not have is not offered, so a swipe never does what the card would not.
 * @param {string[]} available the action ids on the card (cardFor(...).actions.map(a => a.id))
 * @returns {{ leading: any[], trailing: any[] }}
 */
export function swipeActions(available) {
  const has = (id) => available.includes(id);
  const leading = has("done") ? [SWIPE.done] : [];
  const trailing = [has("reassign") ? SWIPE.reassign : null, SWIPE.open].filter(Boolean);
  return { leading, trailing };
}

/** The width of the revealed buttons: one 80 px button each. */
export function revealWidth(count, each = 80) {
  return count * each;
}
