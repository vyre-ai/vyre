// @ts-check
// The words for a drive that is reached through another device. Same shape as the other storage cards (core/wink/storage/cards.js), different
// sentence: the person is told which device the drive hangs off, in plain words.
import { storageCard, size } from "./cards.js";

const clean = (/** @type {unknown} */ s, /** @type {string} */ d) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 64) || d;

/**
 * @param {{ name: string, owner?: string, capacity: number, via: string, classes?: string[], residency?: string, days?: number | null }} i
 */
export function bridgedCard(i) {
  const base = storageCard({ how: "discovery", name: i.name, owner: i.owner, capacity: i.capacity, seenFrom: i.via, classes: i.classes, residency: i.residency, days: i.days });
  const name = clean(i.name, "this drive"), owner = clean(i.owner, "Personal"), via = clean(i.via, "another device");
  const residency = clean(i.residency, "");
  return {
    ...base,
    title: `Add ${name} as storage?`,
    who: `${name}, reached through ${via}`,
    allows: `Lets ${owner} keep encrypted copies on ${name}, up to ${size(i.capacity)}, reached through ${via}. Only scrambled files are written, so neither the drive nor ${via} can read them. Storage works only while ${via} is on and can see the drive.${residency ? ` Where it sits: ${residency}.` : ""}`,
  };
}

/** One plain sentence for when the device that serves the drive is away. @param {{ name: string, via: string, safe: boolean }} i */
export function bridgeAwayWords(i) {
  const name = clean(i.name, "The drive"), via = clean(i.via, "the device it hangs off");
  return i.safe ? `${name} is offline because ${via} is off or away. Everything on it also lives somewhere else. Nothing is at risk.` : `${name} is offline because ${via} is off or away. Turn ${via} on to reach it again.`;
}
