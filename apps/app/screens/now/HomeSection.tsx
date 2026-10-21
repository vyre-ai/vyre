import type { ReactNode } from "react";
import { View } from "react-native";
import { Chip, Text } from "@vyre/ui";

/** The Home column: centred, at most 760 wide, on the 8-point scale between its blocks. */
export function HomeColumn({ children }: { children: ReactNode }) {
  return <View style={{ width: "100%", maxWidth: 760, alignSelf: "center" }} className="gap-s6">{children}</View>;
}

/** A section that has something to show: a small muted label, its count, then the rows. `end` sits on the right of the label. */
export function HomeSection({ title, count, end, children }: { title: string; count?: number; end?: ReactNode; children: ReactNode }) {
  return (
    <View className="min-w-0 gap-s2">
      <View className="min-w-0 flex-row flex-wrap items-center justify-between gap-s2">
        <View className="flex-row items-center gap-s2">
          <Text size="caption" tone="muted">{title}</Text>
          {count === undefined ? null : <Chip>{String(count)}</Chip>}
        </View>
        {end ?? null}
      </View>
      {children}
    </View>
  );
}
