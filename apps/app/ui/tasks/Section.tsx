import { View } from "react-native";
import { SectionLabel } from "../components/SectionLabel";

/** A titled block of a screen: the 11 mono label (with a quiet count) over its content. Blocks stack with 32 between them and 8 under the label. */
export function Section({ title, count, first, children }: { title: string; count?: number; first?: boolean; children: React.ReactNode }) {
  return (
    <View className="min-w-0">
      <SectionLabel first={first} meta={count === undefined ? undefined : String(count)}>{title}</SectionLabel>
      {children}
    </View>
  );
}
