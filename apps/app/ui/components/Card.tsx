import { View, type ViewProps } from "react-native";
import { cn } from "../lib/cn";
import { Text } from "./Text";
import { elevation } from "../lib/elevation";
import { useUiTheme } from "../theme";

/**
 * The one card: a surface, a 1px edge, the card radius, level-1 elevation. Nothing else. No coloured strip on any side
 * (the user, 3 Oct 2026): what needs attention says so with a chip and the words, not a coloured edge.
 * `flush` removes the padding for a card made of Rows.
 */
export function Card({ title, actions, flush, className, children, ...rest }: ViewProps & { title?: string; actions?: React.ReactNode; flush?: boolean; className?: string }) {
  const { resolved } = useUiTheme();
  return (
    <View {...rest} className={cn("min-w-0 rounded-card border border-edge bg-surface-2", flush ? "overflow-hidden" : "p-s4", className)} style={[elevation(resolved.scheme, 1), rest.style]}>
      {title || actions ? (
        <View className={cn("flex-row items-center gap-s3", flush ? "px-s4 pt-s3 pb-s1" : "mb-s3")}>
          {title ? <Text strong className="flex-1">{title}</Text> : <View className="flex-1" />}
          {actions}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/** A hairline between two Rows in a flush Card. */
export function Divider() {
  return <View className="h-px bg-edge" />;
}
