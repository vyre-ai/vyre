// The assistant's own species: a companion creature, clearly not an agent blob (round3's spikier,
// more angular wobble, thin antenna) and not a teammate character (a body, clothes, a role prop).
// Rounder, plumper, a soft glow halo (nothing else here has one), small ears, a curled tail, a
// sparkle in the eye. Seeded from the ASSISTANT's own public id, never the person's, so two
// people's assistants never match even if the people's own avatars happen to.
const PASTELS = ["#F6B8C8", "#B8D9F0", "#C9E8B8", "#F0D48A", "#F0C9A0", "#8AD9C4", "#F0A88A"];
// (a separate palette from agents'/users' own arrays - deliberately, so a creature never reads as
// "an agent in a different pose" purely by colour coincidence; swept clean of violet below)

function hashSeed(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
}
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];

/**
 * The assistant creature. `seed` should be the assistant's own public id (not the person's).
 * A plump, rounded body (a superellipse-like blob, rounder than an agent's wobbled polygon),
 * a translucent glow halo, two small rounded ears, a curled tail, and a bigger, warmer eye style
 * with a sparkle - "alive," the way a simple dot-eyed agent blob deliberately isn't.
 */
function creature(seed, size = 120) {
  const rnd = hashSeed("creature:" + seed);
  const color = pick(rnd, PASTELS);
  const cx = 60, cy = 68, bodyR = 38;
  // A rounder body than the agent blob's 10-point wobble: fewer control points, gentler radius
  // variance, reads as "soft and plump" rather than "irregular."
  const points = 8;
  const pts = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const r = bodyR * (0.94 + rnd() * 0.12);
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * 1.05]);
  }
  let d = `M ${pts[0][0]},${pts[0][1]} `;
  for (let i = 0; i < points; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % points];
    d += `Q ${x0},${y0} ${(x0 + x1) / 2},${(y0 + y1) / 2} `;
  }
  d += "Z";

  const ears = `<circle cx="${cx - 18}" cy="${cy - bodyR - 2}" r="7" fill="${color}"/>
    <circle cx="${cx + 18}" cy="${cy - bodyR - 2}" r="7" fill="${color}"/>`;
  // Tail curls to whichever side the seed picks, computed directly in path coordinates (a
  // transform="scale(-1,1)" trick here risked mirroring around the wrong axis - simpler to just
  // flip the x-offsets by hand).
  const ts = rnd() > 0.5 ? 1 : -1;
  const tail = `<path d="M ${cx + ts * (bodyR - 4)} ${cy + 14} Q ${cx + ts * (bodyR + 18)} ${cy + 20} ${cx + ts * (bodyR + 10)} ${cy + 2}"
    stroke="${color}" stroke-width="7" fill="none" stroke-linecap="round"/>`;
  const halo = `<circle cx="${cx}" cy="${cy}" r="${bodyR + 14}" fill="${color}" opacity="0.18"/>`;
  const ex = 12, ey = 4, ink = "#141311";
  const sparkleSide = rnd() > 0.5 ? -1 : 1;
  const eyes = `<circle cx="${cx - ex}" cy="${cy - ey}" r="5" fill="${ink}"/>
    <circle cx="${cx + ex}" cy="${cy - ey}" r="5" fill="${ink}"/>
    <circle cx="${cx + sparkleSide * ex - 1.5}" cy="${cy - ey - 1.5}" r="1.4" fill="#F1EEE6"/>`;
  const mouth = rnd() > 0.5
    ? `<path d="M ${cx - 7} ${cy + 12} Q ${cx} ${cy + 17} ${cx + 7} ${cy + 12}" stroke="${ink}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}">
    ${halo}${tail}${ears}<path d="${d}" fill="${color}"/>${eyes}${mouth}
  </svg>`;
}

export { creature, PASTELS };
