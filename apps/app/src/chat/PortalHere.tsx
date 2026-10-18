// Draws its children where it stands (native). The web file draws them on the page itself, out from under any scroller or transformed row.
import type { ReactNode } from "react";

export function PortalHere({ children }: { children: ReactNode }) { return <>{children}</>; }
