// Types for the platform files: Transcript.web.tsx (a reversed scroller windowed by chat core
// window.js) and Transcript.native.tsx (an inverted FlatList).
import type { ReactNode } from "react";
import type { TranscriptRow } from "./model";

export type TranscriptProps = {
  /** Oldest first. */
  rows: readonly TranscriptRow[];
  renderRow: (row: TranscriptRow) => ReactNode;
  /** More history exists above: read it when the reader nears the top. */
  hasMore: boolean;
  onNearTop: () => void;
  /** Above the oldest row: "Loading earlier" or nothing. */
  head?: ReactNode;
  /** Scroll to this row (a quote was tapped); a new `n` scrolls again. */
  jumpTo?: { key: string; n: number } | null;
  /** The "Jump to latest" pill, shown while the reader is up in history; `go` scrolls to the tail. */
  jump?: (go: () => void) => ReactNode;
};

/** Newest at the bottom; history loads above without moving what is on screen. */
export function Transcript(p: TranscriptProps): ReactNode;
