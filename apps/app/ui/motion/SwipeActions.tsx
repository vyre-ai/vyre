import { useRef, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import ReanimatedSwipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, { interpolate, useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { Icon, type IconName } from "../components/Icon";
import { Text } from "../components/Text";
import { useUiTheme } from "../theme";
import { haptic, type HapticName } from "./haptics";
import { revealWidth } from "./logic.js";

export type SwipeAction = { id: string; label: string; icon: IconName | string; tone: "ok" | "accent" | "plain"; onPress: () => void; haptic?: HapticName | string };
export type SwipeSet = { leading?: SwipeAction[]; trailing?: SwipeAction[] };

const WASH = { ok: "bg-ok-wash", accent: "bg-accent-wash", plain: "bg-hover" } as const;
const INK = { ok: "ok", accent: "accent", plain: "default" } as const;

function Panel({ actions, progress, close }: { actions: SwipeAction[]; progress: SharedValue<number>; close: () => void }) {
  const lift = useAnimatedStyle(() => ({ opacity: interpolate(progress.value, [0, 0.5, 1], [0, 0.6, 1]), transform: [{ scale: interpolate(progress.value, [0, 1], [0.85, 1], "clamp") }] }));
  return (
    <View style={{ width: revealWidth(actions.length), flexDirection: "row" }}>
      {actions.map((a) => (
        <Animated.View key={a.id} style={[{ flex: 1 }, lift]}>
          <ActionButton a={a} close={close} />
        </Animated.View>
      ))}
    </View>
  );
}

function ActionButton({ a, close }: { a: SwipeAction; close: () => void }) {
  // A real button, so a keyboard, a screen reader and a switch can reach it after the swipe opens it.
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a.label} className={`flex-1 items-center justify-center gap-s1 ${WASH[a.tone]}`}
      onPress={() => { const h = a.haptic; if (h) (haptic as Record<string, (() => void) | undefined>)[h]?.(); close(); a.onPress(); }}>
      <Icon name={a.icon as IconName} size={20} tone={a.tone === "plain" ? "text" : a.tone} />
      <Text size="caption" strong tone={INK[a.tone]}>{a.label}</Text>
    </Pressable>
  );
}

/**
 * Swipe a row or a card to reveal buttons: right for the leading set (Mark done), left for the trailing set (Reassign, Open). Each button is a real
 * button with a label; opening the drawer ticks (haptic.selection), pressing one runs its haptic and its action, then closes. Off when `enabled` is
 * false (a wide screen with a pointer). Rows also expose the same actions to a screen reader's action menu, and a task card has its own buttons.
 */
export function SwipeActions({ leading = [], trailing = [], enabled = true, children }: SwipeSet & { enabled?: boolean; children: ReactNode }) {
  const ref = useRef<SwipeableMethods>(null);
  useUiTheme();
  if (!enabled || (!leading.length && !trailing.length)) return <>{children}</>;
  const close = () => ref.current?.close();
  return (
    <ReanimatedSwipeable
      ref={ref}
      friction={2}
      overshootLeft={false}
      overshootRight={false}
      onSwipeableOpen={() => haptic.selection()}
      renderLeftActions={leading.length ? (progress) => <Panel actions={leading} progress={progress} close={close} /> : undefined}
      renderRightActions={trailing.length ? (progress) => <Panel actions={trailing} progress={progress} close={close} /> : undefined}
    >
      {children}
    </ReanimatedSwipeable>
  );
}
