// Types for the platform files: SwipeRow.web.tsx (a scroll-snap strip) and SwipeRow.native.tsx
// (Gesture Handler and Reanimated on the UI thread).
import type { ReactNode } from "react";
import type { Decision } from "../state/needs-model";

export type SwipeRowProps = {
  children: ReactNode;
  height: number;
  /** A swipe reached its end. True: it committed and the row collapses on this frame. False: it snaps back (the item opens instead). */
  onSwipe: (d: Decision) => boolean;
  /** The label on each side; "Open" when a commit would be refused (presence, a question). */
  approveLabel: string;
  rejectLabel: string;
};

/** A row that answers with a swipe: right approves, left denies (DIRECTION.md, the Needs board). */
export function SwipeRow(p: SwipeRowProps): ReactNode;
