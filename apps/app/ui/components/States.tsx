import { useEffect } from "react";
import { View } from "react-native";
import { Text } from "./Text";
import { Button } from "./Button";
import { SkeletonRows } from "../motion/Skeleton";
import { isSettingUp, SETTING_UP_RETRY_MS, SETTING_UP_WORDS } from "./setting-up.js";

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

/** A failed call or load: what happened, what to do about it (`recourse`) and the code to quote when asking for help. The words come from errorNote() (src/real/error-note.js). */
export function ErrorState({ title, reason, retry, recourse, code }: { title: string; reason?: string; retry?: () => void; recourse?: string; code?: string }) {
  // Records still being set up (a first start takes minutes) is not a failure: say so calmly and ask again by itself.
  const settingUp = isSettingUp(reason);
  useEffect(() => {
    if (!settingUp || !retry) return undefined;
    const t = setInterval(retry, SETTING_UP_RETRY_MS);
    return () => clearInterval(t);
  }, [settingUp, retry]);
  if (settingUp) {
    return (
      <View accessibilityRole="progressbar" className="items-center gap-s2 p-s6">
        <Text strong>{SETTING_UP_WORDS.title}</Text>
        <Text tone="muted" className="text-center">{SETTING_UP_WORDS.body}</Text>
      </View>
    );
  }
  return (
    <View accessibilityRole="alert" className="items-center gap-s2 p-s6">
      <Text strong tone="err">{title}</Text>
      {reason ? <Text tone="muted" className="text-center">{reason}</Text> : null}
      {recourse ? <Text className="text-center">{recourse}</Text> : null}
      {code ? <Text tone="muted" className="text-center">{`Code: ${code}`}</Text> : null}
      {retry ? <Button size="sm" label="Try again" onPress={retry} /> : null}
    </View>
  );
}

/** A list that is still loading: the shape of its rows, shining, never a spinner and never a blank flash. */
export function LoadingState({ rows = 4 }: { rows?: number }) {
  return <SkeletonRows rows={rows} />;
}
