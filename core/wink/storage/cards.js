// @ts-check
// cards: the words a person reads before a drive or a bucket is added as storage. Four lines (who, where it goes, what it allows, for how long)
// and two buttons, in plain words, in the shape of core/wink/cards.js. Nothing here says network, node, key, token, address, relay, route or box.
// Everything a storage device holds is encrypted before it gets there; the card says so in one sentence.

/** Bytes as a person says them: 1.5 TB, 300 GB. Decimal units, as drive makers print them. @param {number} n */
export function size(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "an unstated amount";
  const units = [["TB", 1e12], ["GB", 1e9], ["MB", 1e6]];
  for (const [u, f] of /** @type {[string, number][]} */ (units)) if (v >= f) { const x = v / f; return `${x >= 100 ? Math.round(x) : Math.round(x * 10) / 10} ${u}`.replace(/\.0 /, " "); }
  return `${Math.round(v / 1e3)} KB`;
}

const clean = (/** @type {unknown} */ s, /** @type {string} */ d) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 64) || d;
const WHAT = /** @type {Record<string, string>} */ ({ cold: "old versions and archives", backup: "backups", working: "a spare copy of current files" });

/**
 * @param {{ how: "discovery" | "credentials", name: string, owner?: string, capacity: number, seenFrom?: string, classes?: string[], days?: number | null, residency?: string, kind?: string }} i
 */
export function storageCard(i) {
  const name = clean(i.name, "this storage");
  const owner = clean(i.owner, "Personal");
  const room = size(i.capacity);
  const classes = (i.classes && i.classes.length ? i.classes : ["cold", "backup"]).map(c => WHAT[c]).filter(Boolean);
  const holds = classes.length > 1 ? `${classes.slice(0, -1).join(", ")} and ${classes[classes.length - 1]}` : classes[0] || "encrypted copies";
  const where = i.how === "discovery" && i.seenFrom ? `${name}, seen from ${clean(i.seenFrom, "this device")}` : name;
  const login = i.how === "credentials" ? " The login you pasted goes into your vault and is never shown again." : "";
  const residency = clean(i.residency, "");
  return {
    kind: "storage", open: /** @type {true} */ (true),
    title: `Add ${name} as storage?`,
    who: where,
    goesInto: `Goes into: ${owner}`,
    allows: `Lets ${owner} keep encrypted copies here, up to ${room}. It holds ${holds}. Only scrambled files are written here, so the drive cannot read them.${login}${residency ? ` Where it sits: ${residency}.` : ""}`,
    forHowLong: i.days ? `${i.days} days` : "Until you remove it",
    primary: "Add storage", secondary: "Not now", sensitive: true,
  };
}

/** The confirm words for taking storage back. @param {{ name: string, drain: boolean }} i */
export function removeWords(i) {
  const name = clean(i.name, "this storage");
  return i.drain
    ? { prompt: `Stop using ${name}? Vyre copies everything off it first, then lets it go. It stays in the list until that is done.`, primary: "Copy off and remove", secondary: "Cancel" }
    : { prompt: `Remove ${name} now? Anything that lives only there is not copied off first. The files on it stay on the drive, scrambled.`, primary: "Remove now", secondary: "Cancel" };
}
