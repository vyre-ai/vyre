import { Text } from "../components/Text";
import { RAIL } from "./rail-tokens.js";

/** A small group label: 12, sentence case, muted, 20 above, on the 16 gutter. */
export function SidebarLabel({ children, first }: { children: string; first?: boolean }) {
  return <Text tone="label" numberOfLines={1} style={{ paddingHorizontal: RAIL.gutter, paddingTop: first ? 0 : RAIL.sectionLabelAbove, paddingBottom: 4, fontSize: RAIL.sectionLabelSize, lineHeight: 16 }}>{children}</Text>;
}

