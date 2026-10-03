import { memo } from "react";
import { Pressable, View } from "react-native";
import { SvgAst } from "react-native-svg";
import Animated, { Easing, interpolate, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useUiTheme } from "../theme";
import { useReducedMotion } from "../motion/useReducedMotion";
import { motion } from "../motion/tokens";
import { useMark, type MarkRef } from "../marks/useMark";
import { Text } from "./Text";

/** What a mark stands for. Person, assistant, teammate and agent are faces and characters; project (matter, trip) and space are emblems; device a line drawing. */
export type AvatarKind = MarkRef["kind"];
export type AvatarRef = MarkRef;
export type AvatarSize = 16 | 20 | 24 | 28 | 32 | 40 | 44 | 56;
export type { MarkRef };

/** The space badge: 16 at 40 and above, scaled below so it never covers the face. The ring is 2 in the card colour. */
export const badgePx = (size: number) => (size >= 40 ? 16 : size >= 28 ? 14 : 12);
const RING = 2;

/** The same kind and id as a Row or card names them; the family a screen's actor record carries ("service" is an agent). */
export function kindOf(family?: string): AvatarKind {
  return family === "assistant" ? "assistant" : family === "teammate" ? "teammate" : family === "service" || family === "agent" ? "agent" : family === "device" || family === "space" || family === "project" ? family : "person";
}

function Mark({ of, size }: { of: AvatarRef; size: number }) {
  const ast = useMark(of, size);
  if (!ast) return <View style={{ width: size, height: size }} />;
  return <SvgAst ast={ast} override={{ width: size, height: size }} />;
}

/**
 * The space an avatar belongs to, as the 16 pt emblem badge at the bottom right (the "Harlow Legal" and "Mine" text chips are gone). `ring`
 * is the colour of the card it sits on, so the 2 pt ring reads as a gap.
 */
function Badge({ space, size, ring }: { space: AvatarRef; size: number; ring?: string }) {
  const { color } = useUiTheme();
  const b = badgePx(size);
  return (
    <View pointerEvents="none" style={{ position: "absolute", right: -RING, bottom: -RING, width: b + RING * 2, height: b + RING * 2, borderRadius: (b + RING * 2) * 0.3, backgroundColor: ring ?? color["surface-2"], alignItems: "center", justifyContent: "center" }}>
      <Mark of={{ ...space, kind: "space" }} size={b} />
    </View>
  );
}

const NOD = motion.duration.nod;

/**
 * Who or what, as a mark. No letters, ever: a person or assistant has a Wink face, a teammate or agent a character, a project or matter an emblem,
 * a space its space emblem, a device its drawing. Every one is the Deck's generator on the entity's seed (`seed`, else `id`), so the same record
 * looks the same everywhere. `space` draws the space's emblem badge. With `onPress` it is a button and nods (scale 0.86, 1.1, 1 with a 5 degree
 * tilt over 460 ms and an accent ring); under reduced motion only the ring flashes, 160 ms.
 */
export const Avatar = memo(function Avatar({ of, size = 32, space, onPress, ring, label }: { of: AvatarRef; size?: AvatarSize; space?: AvatarRef; onPress?: () => void; ring?: string; label?: string }) {
  const { color } = useUiTheme();
  const reduced = useReducedMotion();
  const p = useSharedValue(0);
  const style = useAnimatedStyle(() => ({
    transform: reduced ? [] : [{ scale: interpolate(p.value, [0, 0.25, 0.6, 1], [1, 0.86, 1.1, 1]) }, { rotate: `${interpolate(p.value, [0, 0.4, 1], [0, 5, 0])}deg` }],
  }));
  const flash = useAnimatedStyle(() => ({ opacity: interpolate(p.value, [0, 0.2, 1], [0, 1, 0]) }));
  const box = { width: size, height: size };
  const body = (
    <Animated.View style={[box, style]}>
      <Mark of={of} size={size} />
      <Animated.View pointerEvents="none" style={[{ position: "absolute", left: -2, top: -2, right: -2, bottom: -2, borderRadius: of.kind === "person" || of.kind === "assistant" ? size : size * 0.3, borderWidth: 2, borderColor: color.accent }, flash]} />
      {space ? <Badge space={space} size={size} ring={ring} /> : null}
    </Animated.View>
  );
  if (!onPress) return <View accessibilityLabel={label ?? of.name} accessible={false} style={box}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? of.name}
      hitSlop={size < 44 ? (44 - size) / 2 : 0}
      onPress={() => {
        p.value = 0;
        p.value = withTiming(1, { duration: reduced ? 160 : NOD, easing: Easing.out(Easing.cubic) });
        onPress();
      }}
      style={box}
    >
      {body}
    </Pressable>
  );
});

/** A space on its own: its emblem at 16, 28 or 56 (radius follows the emblem), never a letter tile. */
export function SpaceMark({ space, size = 28, onPress }: { space: AvatarRef; size?: 16 | 20 | 24 | 28 | 32 | 40 | 44 | 56; onPress?: () => void }) {
  return <Avatar of={{ ...space, kind: "space" }} size={size as AvatarSize} onPress={onPress} />;
}

/** Faces, overlapping by 10, newest on top; more than `max` shows "+N" in the label colour. */
export function AvatarStack({ of, size = 28, max = 3, space }: { of: AvatarRef[]; size?: 20 | 24 | 28 | 32 | 40; max?: number; space?: AvatarRef }) {
  const { color } = useUiTheme();
  const shown = of.slice(0, max);
  const more = of.length - shown.length;
  return (
    <View accessibilityLabel={of.map((a) => a.name).join(", ")} style={{ flexDirection: "row", alignItems: "center" }}>
      {shown.map((a, i) => (
        <View key={a.kind + a.id} style={{ marginLeft: i === 0 ? 0 : -10, borderRadius: size, borderWidth: 2, borderColor: color["surface-2"], backgroundColor: color["surface-2"], zIndex: shown.length - i }}>
          <Avatar of={a} size={size as AvatarSize} space={i === 0 ? space : undefined} />
        </View>
      ))}
      {more > 0 ? <View style={{ marginLeft: 6 }}><Text size="caption" tone="label">{`+${more}`}</Text></View> : null}
    </View>
  );
}
