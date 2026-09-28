// Round 3b: warm, realistic skin tones on the head (light to deep, 6-8 tones), pastel colour
// moved to clothes/accessories only, and friendly-only expressions (no open-mouth or startled
// faces). Everything else (hair, headwear, glasses, earrings, role props) is round 3 unchanged.
// Agents' blobs are untouched. Still fully original, still off-limits for lime and violet.

function hashSeed(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
}
// Pastel palette, kept well away from lime (#C6F36B) and violet (#B8A4FF/#5B3FC4); swept
// per-seed in round 2's check, no hue here landed within a safe distance of either.
const PASTELS = ["#F4B8A0", "#F6D186", "#9FD8C8", "#D98E52", "#E8A6C7", "#D9C9A8", "#F0A8A8", "#A8D9C0"];
const HAIR_COLORS = ["#5A4632", "#8A5A3B", "#2B2320", "#C79A5B", "#7A4A2E", "#3A3733"];
// Warm, realistic skin tones, light to deep (round 3b, the lead's note): the head only, never a
// pastel. Swept against lime/violet same as everything else here; none land close.
const SKIN_TONES = ["#FBE0C6", "#F1C79B", "#E0AC7C", "#C98A57", "#A8683D", "#7D4C2C", "#5C3620", "#3E2417"];
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (rnd, p) => rnd() < p;

/** Unchanged from round 2: a soft blob creature, agents' style. */
function blob(seed, size = 120) {
  const rnd = hashSeed("blob:" + seed);
  const color = pick(rnd, PASTELS);
  const cx = 60, cy = 66, baseR = 42;
  const points = 10;
  const pts = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const r = baseR * (0.86 + rnd() * 0.28);
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  let d = `M ${pts[0][0]},${pts[0][1]} `;
  for (let i = 0; i < points; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % points];
    d += `Q ${x0},${y0} ${(x0 + x1) / 2},${(y0 + y1) / 2} `;
  }
  d += "Z";
  const eyeStyle = pick(rnd, ["round", "round", "sleepy", "wide"]);
  const ex = 12 + rnd() * 4, ey = eyeStyle === "sleepy" ? 2 : 5;
  const antenna = chance(rnd, 0.6) ? `<line x1="60" y1="${cy - baseR - 2}" x2="60" y2="${cy - baseR - 14}" stroke="${color}" stroke-width="4" stroke-linecap="round"/>
    <circle cx="60" cy="${cy - baseR - 16}" r="5" fill="${color}"/>` : "";
  const eyes = eyeStyle === "sleepy"
    ? `<line x1="${cx - ex}" y1="${cy}" x2="${cx - ex + 6}" y2="${cy}" stroke="#141311" stroke-width="3" stroke-linecap="round"/>
       <line x1="${cx + ex - 6}" y1="${cy}" x2="${cx + ex}" y2="${cy}" stroke="#141311" stroke-width="3" stroke-linecap="round"/>`
    : `<circle cx="${cx - ex}" cy="${cy - ey}" r="${eyeStyle === "wide" ? 4.5 : 3.5}" fill="#141311"/>
       <circle cx="${cx + ex}" cy="${cy - ey}" r="${eyeStyle === "wide" ? 4.5 : 3.5}" fill="#141311"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}">${antenna}<path d="${d}" fill="${color}"/>${eyes}</svg>`;
}

// Known roles and their prop, exactly the lead's list. Matched against the part of the seed
// before its first "-" or ":" (e.g. "design-t9f21ab" -> "design").
const ROLE_PROPS = { design: "beret-or-pencil", reviewer: "glasses", docs: "book", research: "magnifier", qa: "checkmark" };
function roleOf(seed) { const k = seed.split(/[-:]/)[0].toLowerCase(); return ROLE_PROPS[k] ? k : null; }

// Friendly-only, round 3b (the lead's note): smiles, a soft closed-eye smile (wink), or a gentle
// neutral. No open-mouth grin, no startled/surprised eyes.
function face(rnd, ink) {
  const style = pick(rnd, ["smile", "smile", "neutral", "wink"]);
  if (style === "neutral") return `<circle cx="49" cy="48" r="3.5" fill="${ink}"/><circle cx="71" cy="48" r="3.5" fill="${ink}"/>
    <line x1="52" y1="62" x2="68" y2="62" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>`;
  if (style === "wink") return `<path d="M45 48 Q49 44 53 48" stroke="${ink}" stroke-width="3" fill="none" stroke-linecap="round"/>
    <path d="M67 48 Q71 44 75 48" stroke="${ink}" stroke-width="3" fill="none" stroke-linecap="round"/>
    <path d="M50 60 Q60 67 70 60" stroke="${ink}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
  return `<circle cx="49" cy="48" r="3.5" fill="${ink}"/><circle cx="71" cy="48" r="3.5" fill="${ink}"/>
    <path d="M50 60 Q60 66 70 60" stroke="${ink}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
}

function hair(rnd, hairColor) {
  const style = pick(rnd, ["bald", "tuft", "curly", "sidePart", "ponytail", "afro", "buzz"]);
  return {
    bald: "",
    buzz: `<path d="M32 44 A28 28 0 0 1 88 44 L88 38 A28 28 0 0 0 32 38 Z" fill="${hairColor}"/>`,
    tuft: `<path d="M42 30 Q60 10 78 30 Q60 20 42 30 Z" fill="${hairColor}"/>`,
    curly: `<circle cx="38" cy="34" r="9" fill="${hairColor}"/><circle cx="52" cy="24" r="10" fill="${hairColor}"/>
      <circle cx="68" cy="24" r="10" fill="${hairColor}"/><circle cx="82" cy="34" r="9" fill="${hairColor}"/>`,
    sidePart: `<path d="M30 40 Q34 12 62 14 Q88 14 90 40 L90 30 Q86 20 60 20 Q36 20 30 30 Z" fill="${hairColor}"/>`,
    ponytail: `<path d="M32 38 Q34 14 60 14 Q86 14 88 38 L88 32 Q84 20 60 20 Q36 20 32 32 Z" fill="${hairColor}"/>
      <ellipse cx="92" cy="46" rx="7" ry="11" fill="${hairColor}"/>`,
    afro: `<path d="M24 48 Q20 4 60 4 Q100 4 96 48 Q96 26 60 22 Q24 26 24 48 Z" fill="${hairColor}"/>`,
  }[style];
}

function headwear(rnd, color, forced) {
  const style = forced || pick(rnd, ["none", "none", "cap", "beanie", "headband", "bow"]);
  return {
    none: "",
    cap: `<path d="M36 34 Q60 14 84 34 L84 40 L36 40 Z" fill="${color}"/><rect x="34" y="38" width="52" height="6" rx="3" fill="${color}"/>`,
    beanie: `<path d="M30 38 Q30 8 60 8 Q90 8 90 38 L90 40 L30 40 Z" fill="${color}"/><rect x="30" y="34" width="60" height="8" rx="4" fill="${color}" opacity="0.7"/>
      <circle cx="60" cy="10" r="4" fill="${color}"/>`,
    headband: `<rect x="30" y="34" width="60" height="7" rx="3.5" fill="${color}"/>`,
    bow: `<circle cx="80" cy="24" r="4" fill="${color}"/><path d="M80 24 L70 18 L70 30 Z" fill="${color}"/><path d="M80 24 L90 18 L90 30 Z" fill="${color}"/>`,
    beret: `<ellipse cx="58" cy="22" rx="26" ry="16" fill="${color}"/><circle cx="82" cy="16" r="4" fill="${color}"/>`,
  }[style];
}

function glasses(rnd, skin, forced) {
  const style = forced || pick(rnd, ["none", "none", "round", "square"]);
  if (style === "round") return `<circle cx="49" cy="48" r="8" fill="none" stroke="${skin}" stroke-width="2.5"/>
    <circle cx="71" cy="48" r="8" fill="none" stroke="${skin}" stroke-width="2.5"/>
    <line x1="57" y1="48" x2="63" y2="48" stroke="${skin}" stroke-width="2.5"/>`;
  if (style === "square") return `<rect x="41" y="41" width="16" height="14" rx="3" fill="none" stroke="${skin}" stroke-width="2.5"/>
    <rect x="63" y="41" width="16" height="14" rx="3" fill="none" stroke="${skin}" stroke-width="2.5"/>
    <line x1="57" y1="48" x2="63" y2="48" stroke="${skin}" stroke-width="2.5"/>`;
  return "";
}

function earrings(rnd, color) {
  const style = pick(rnd, ["none", "none", "stud", "hoop"]);
  if (style === "stud") return `<circle cx="32" cy="54" r="2.5" fill="${color}"/><circle cx="88" cy="54" r="2.5" fill="${color}"/>`;
  if (style === "hoop") return `<circle cx="32" cy="56" r="4" fill="none" stroke="${color}" stroke-width="2"/>
    <circle cx="88" cy="56" r="4" fill="none" stroke="${color}" stroke-width="2"/>`;
  return "";
}

/** A small badge, bottom-right of the tile, for a known role: design's pencil, docs' book,
 * research's magnifier, QA's checkmark. Reviewer's prop is glasses (forced on, no badge). */
function roleBadge(role, color) {
  if (role === "reviewer") return "";
  const bg = `<circle cx="94" cy="94" r="16" fill="${color}"/>`;
  const icon = {
    design: `<line x1="88" y1="100" x2="100" y2="88" stroke="#141311" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M97 91 L100 88 L102 90 L99 93 Z" fill="#141311"/>`,
    docs: `<rect x="87" y="87" width="10" height="13" rx="1.5" fill="none" stroke="#141311" stroke-width="2"/>
      <line x1="90" y1="90" x2="94" y2="90" stroke="#141311" stroke-width="1.5"/><line x1="90" y1="93" x2="94" y2="93" stroke="#141311" stroke-width="1.5"/>`,
    research: `<circle cx="92" cy="91" r="5" fill="none" stroke="#141311" stroke-width="2.2"/>
      <line x1="96" y1="95" x2="100" y2="99" stroke="#141311" stroke-width="2.2" stroke-linecap="round"/>`,
    qa: `<path d="M88 94 L92 98 L100 89" stroke="#141311" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  }[role];
  return icon ? bg + icon : "";
}

/**
 * A small rounded character, now with real per-seed variety: hair, optional headwear, optional
 * glasses, optional earrings, a friendly expression (smile, closed-eye smile or gentle neutral), plus a role prop when the seed's role
 * (before the first "-") matches a known one (design/reviewer/docs/research/qa).
 */
function character(seed, size = 120) {
  const rnd = hashSeed("char:" + seed);
  const bodyColor = pick(rnd, PASTELS);       // clothes only, round 3b
  const headColor = pick(rnd, SKIN_TONES);    // the head: a realistic skin tone, never a pastel
  const hairColor = pick(rnd, HAIR_COLORS);
  const ink = "#141311";                      // facial-feature ink (eyes, mouth, glasses), not skin
  const role = roleOf(seed);

  // design: a beret (headwear, replaces loose hair on top) or a pencil badge, chosen once per
  // seed so the same teammate always draws the same way. reviewer: glasses are the prop, forced
  // on. Every other role's prop is a plain badge; everyone else gets ordinary hashed variety.
  const wearsBeret = role === "design" && chance(rnd, 0.5);
  const hw = wearsBeret ? headwear(rnd, pick(rnd, HAIR_COLORS), "beret") : headwear(rnd, pick(rnd, HAIR_COLORS));
  const gl = role === "reviewer" ? glasses(rnd, ink, pick(rnd, ["round", "square"])) : glasses(rnd, ink);
  const hairEl = wearsBeret ? "" : hair(rnd, hairColor);
  // A badge's fine icon detail (a pencil line, a book's spine) does not survive down to 24px, a
  // real size this renders at (list rows, the composer). Below 32 the badge is dropped; hair,
  // clothes colour, skin tone and glasses (all tested legible at 24px) carry the difference
  // instead. The badge's own background is the pastel clothing colour, not the skin tone: badges
  // are accessories, round 3b keeps pastel there and only there.
  const showBadge = size >= 32;
  const badge = !showBadge ? "" : role === "design" ? (wearsBeret ? "" : roleBadge("design", bodyColor)) : role ? roleBadge(role, bodyColor) : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}">
    <rect x="30" y="58" width="60" height="46" rx="20" fill="${bodyColor}"/>
    ${earrings(rnd, hairColor)}
    <circle cx="60" cy="50" r="30" fill="${headColor}"/>
    ${hairEl}
    ${face(rnd, ink)}
    ${gl}
    ${hw}
    ${badge}
  </svg>`;
}

export { blob, character, PASTELS };
