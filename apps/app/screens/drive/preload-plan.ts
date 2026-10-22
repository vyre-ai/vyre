// Which neighbours Quick Look reads ahead. A Space file's neighbours are the other Space files in the list. A linked-folder file's neighbours are the other files in that same folder. Folders are not read ahead.

export type Ahead = { key: string; dir: boolean; root: string; path: string; size: number; link?: string };

/** The next file, the previous one, and one further on. */
export function aheadOf(shown: Ahead[], key: string): Ahead[] {
  const row = shown.find((r) => r.key === key);
  if (!row || row.dir) return [];
  const files = shown.filter((r) => !r.dir && r.root === row.root && (row.root !== "linked" || r.link === row.link));
  const i = files.findIndex((r) => r.key === key);
  if (i < 0) return [];
  return [files[i + 1], files[i - 1], files[i + 2]].filter((n): n is Ahead => Boolean(n));
}
