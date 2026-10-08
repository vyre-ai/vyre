// The pure half of the pairing card on Now: a new device asking to pair over Wink, confirmed by three words.

/** "A new device is asking" from wink.phone.pairing, which sends { asking, name, choices, until, line } and no words: the person types the words the new device shows. Same shape the Devices screen reads. */
export function winkAsking(r: unknown): { name: string; words: [string, string, string] | null } | null {
  const x = r as { asking?: boolean; name?: unknown; words?: unknown } | null;
  if (!x || x.asking !== true) return null;
  const a = Array.isArray(x.words) ? x.words.map(String) : typeof x.words === "string" ? x.words.trim().split(/\s+/) : [];
  const words = a.length === 3 && a.every(Boolean) ? (a.map((w) => w.toLowerCase()) as [string, string, string]) : null;
  return { name: String(x.name || "A new device"), words };
}

/** Events that mean the request changed. */
export const PAIR_EVENTS = /^wink\./;

export const pairedLine = (name: string): string => `${name} is paired. Its sessions and files show up here in a minute.`;
export const notPairedLine = (name: string): string => `Refused. ${name} was told no.`;
