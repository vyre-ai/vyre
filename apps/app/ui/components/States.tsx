import { View } from "react-native";
import { Text } from "./Text";
import { Button } from "./Button";
import { SkeletonRows } from "../motion/Skeleton";

/** The state kit: say what happened and what to do next. */
export function EmptyState({ title, body, action }: { title: string; body?: string; action?: { label: string; onPress: () => void } }) {
  return (
    <View className="items-center gap-s2 p-s6">
      <Text strong>{title}</Text>
      {body ? <Text tone="muted" className="text-center">{body}</Text> : null}
      {action ? <Button kind="primary" size="sm" label={action.label} onPress={action.onPress} /> : null}
    </View>
  );
}

export function ErrorState({ title, reason, retry }: { title: string; reason?: string; retry?: () => void }) {
  return (
    <View accessibilityRole="alert" className="items-center gap-s2 p-s6">
      <Text strong tone="err">{title}</Text>
      {reason ? <Text tone="muted" className="text-center">{reason}</Text> : null}
      {retry ? <Button size="sm" label="Try again" onPress={retry} /> : null}
    </View>
  );
}

/** A list that is still loading: the shape of its rows, shining, never a spinner and never a blank flash. */
export function LoadingState({ rows = 4 }: { rows?: number }) {
  return <SkeletonRows rows={rows} />;
}
