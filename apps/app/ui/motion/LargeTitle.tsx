import { useState, type ReactNode } from "react";
import { Platform, RefreshControl, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedScrollHandler, useAnimatedStyle, useDerivedValue, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { Text } from "../components/Text";
import { useUiTheme } from "../theme";
import { SPRING, motion } from "./tokens";
import { useReducedMotion } from "./useReducedMotion";

const RANGE = 56;
const BAR = 44;

/**
 * One screen: a scrolling page with a title.
 * On a phone it is Apple's large title: the title sits big at the top of the page; as it scrolls away a small title springs into a bar that stays.
 * Android gets the same component as a medium top app bar (the small title left-aligned, the large title sized as the medium bar's headline).
 * `onRefresh` adds pull to refresh (the system's refresh control; the page keeps its content while it runs).
 * On a wide screen there is no bar: the title is the first line of the page, as before.
 */
export function LargeTitleScreen({ title, sub, actions, onRefresh, children, own, wide }: {
  title: string; /** A two-column page (Now): the content stops at the wide width (1040) with a 32 gutter on a wide screen. */ wide?: boolean; sub?: string; actions?: ReactNode; /** The page draws its own large title (a heading with its own actions); this supplies the bar, the collapse and the refresh. */ own?: boolean; onRefresh?: () => void | Promise<void>; children: ReactNode;
}) {
  const { phone, color, map } = useUiTheme();
  const px = (k: string) => parseInt(String(map[k]), 10) || 0;
  const reduced = useReducedMotion();
  const [refreshing, setRefreshing] = useState(false);
  const y = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => { y.value = e.contentOffset.y; });
  // The bar's small title and hairline: one spring on whether the large title has scrolled out. Reduced motion: a plain fade, no spring.
  const shown = useDerivedValue(() => {
    const out = y.value > RANGE ? 1 : 0;
    return reduced ? withTiming(out, { duration: motion.duration.state }) : withSpring(out, SPRING["effects.fast"]);
  });
  const small = useAnimatedStyle(() => ({ opacity: shown.value, transform: [{ translateY: reduced ? 0 : (1 - shown.value) * 6 }] }));
  const bar = useAnimatedStyle(() => ({ opacity: shown.value }));
  const android = Platform.OS === "android";
  const refresh = onRefresh
    ? <RefreshControl refreshing={refreshing} tintColor={color["text-2"]} colors={[color.accent]} progressBackgroundColor={color["surface-3"]}
        onRefresh={async () => { setRefreshing(true); try { await onRefresh(); } finally { setRefreshing(false); } }} />
    : undefined;
  const head = own ? null : (
    <View className="flex-row flex-wrap items-end gap-s3">
      <View className="min-w-menu flex-1 gap-s1">
        <Text size="page" strong accessibilityRole="header">{title}</Text>
        {sub ? <Text size="caption" tone="label">{sub}</Text> : null}
      </View>
      {actions ? <View className="flex-row flex-wrap items-center gap-s2">{actions}</View> : null}
    </View>
  );
  // Plain style objects, not classes: a className on an animated ScrollView does not reach its content container.
  const wideOn = !!wide && !phone;
  const content: ViewStyle = wideOn
    ? { width: "100%", maxWidth: px("--wide-max") + 2 * px("--s-8"), alignSelf: "center", gap: px("--s-4"), paddingHorizontal: px("--s-8"), paddingTop: px("--s-6"), paddingBottom: px("--s-12") }
    : { width: "100%", maxWidth: px("--page-max") || undefined, alignSelf: "center", gap: px("--s-4"), padding: px("--s-4"), paddingBottom: px("--s-12") };
  if (!phone) {
    return (
      <Animated.ScrollView refreshControl={refresh} style={{ flex: 1 }} contentContainerStyle={content}>
        {head}
        {children}
      </Animated.ScrollView>
    );
  }
  return (
    <View className="min-h-0 flex-1">
      <Animated.ScrollView onScroll={onScroll} scrollEventThrottle={16} refreshControl={refresh} style={{ flex: 1 }} contentContainerStyle={content}>
        {head}
        {children}
      </Animated.ScrollView>
      <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, height: BAR } as StyleProp<ViewStyle>}>
        <Animated.View style={[{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: color.bg, borderBottomWidth: 1, borderBottomColor: color.edge }, bar]} />
        <Animated.View style={[{ flex: 1, justifyContent: "center", paddingHorizontal: 16, alignItems: android ? "flex-start" : "center" }, small]}>
          <Text strong numberOfLines={1}>{title}</Text>
        </Animated.View>
      </View>
    </View>
  );
}
