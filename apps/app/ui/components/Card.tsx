import { View, type ViewProps } from "react-native";
import { cn } from "../lib/cn";
import { Text } from "./Text";
import { elevation } from "../lib/elevation";
import { useUiTheme } from "../theme";
import { CardFill } from "../lib/cardFill";

/**
 * The one card (ui-system.md section 1): surface-2 on the --bg ground, radius 16 on a phone and 14 wider, a 1 px edge and the 1 px top highlight, level-1
 * elevation, padding 16. Nothing else: no coloured strip or edge on any side. `hero` (a decision waits on the person: the Ask card) steps to surface-3,
 * radius 20 or 16, padding 20 and level-2 elevation. A grouped list is one `flush` card of Rows with inset separators (padding is the rows').
 */
export function Card({ title, actions, flush, hero, className, children, ...rest }: ViewProps & { title?: string; actions?: React.ReactNode; flush?: boolean; hero?: boolean; className?: string }) {
  const { resolved } = useUiTheme();
  return (
    <View {...rest} className={cn("min-w-0 border border-edge", hero ? "rounded-cardHero bg-surface-3" : "rounded-card bg-surface-2", flush ? "overflow-hidden" : hero ? "p-s5" : "p-s4", className)} style={[elevation(resolved.scheme, 1), rest.style]}>
      <CardFill.Provider value={hero ? "surface-3" : "surface-2"}>
      {title || actions ? (
        <View className={cn("flex-row items-center gap-s3", flush ? "px-s4 pt-s3 pb-s1" : "mb-s3")}>
          {title ? <Text strong size="headline" className="flex-1">{title}</Text> : <View className="flex-1" />}
          {actions}
        </View>
      ) : null}
      {children}
      </CardFill.Provider>
    </View>
  );
}

/** A hairline between two Rows in a flush Card, inset from the left to sit under the text (`inset` 60 after a 32 mark, 68 after a 40 mark; 0 for a full-width line). */
export function Divider({ inset = 0 }: { inset?: 0 | 60 | 68 }) {
  return <View className="h-px bg-edge" style={inset ? { marginLeft: inset } : undefined} />;
}
