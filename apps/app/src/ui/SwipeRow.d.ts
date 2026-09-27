// Types for the platform files: SwipeRow.web.tsx (pointer events on the row's face) and
// SwipeRow.native.tsx (Gesture Handler and Reanimated on the UI thread). Both release by swipe.js.
import type { ReactNode } from "react";
import type { Decision } from "../state/needs-model";

export type SwipeRowProps = {
  children: ReactNode;
  height: number;
  /** A swipe committed (a full reveal, a fling, or a tap on the revealed action). True: the row collapses on this frame. False: it springs back (the item opens instead). */
  onSwipe: (d: Decision) => boolean;
  /** The label on each side; "Open" when a commit would be refused (presence, a question). */
  approveLabel: string;
  rejectLabel: string;
  /** The row face's testID (data-testid on the web): the element a synthetic swipe drags. */
  testID?: string;
};

/** A row that answers with a swipe: right approves, left denies (DIRECTION.md, the Needs board). */
export function SwipeRow(p: SwipeRowProps): ReactNode;
