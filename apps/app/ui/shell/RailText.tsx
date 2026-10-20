// The sidebar's two text styles, for screens that draw their own sidebar rows (Files' tree): a row's label and a group's heading, at the rail's own size and line, so every sidebar reads the same.
import type { ReactNode } from "react";
import { Text } from "../components/Text";
import { RAIL } from "./rail-tokens.js";

/** A sidebar row's label. */
export function RailLabel({ children, medium }: { children: ReactNode; medium?: boolean }) {
  return <Text medium={medium} style={{ fontSize: RAIL.labelSize, lineHeight: RAIL.labelLine }}>{children}</Text>;
}

/** A sidebar group's heading. */
export function RailHeading({ children }: { children: ReactNode }) {
  return <Text tone="label" style={{ fontSize: RAIL.sectionLabelSize, lineHeight: 16 }}>{children}</Text>;
}
