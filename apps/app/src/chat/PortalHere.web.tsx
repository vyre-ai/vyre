// Draws its children on the page itself (document.body): a menu opened from inside the transcript is not clipped by the scroller or moved by a transformed row (a fixed box inside a transformed parent is placed against that parent).
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

export function PortalHere({ children }: { children: ReactNode }) {
  return typeof document === "undefined" ? <>{children}</> : createPortal(children, document.body);
}
