import { useState } from "react";
import { Platform, Pressable, StyleSheet, Text, useWindowDimensions, View, type ViewStyle } from "react-native";
import { useNavigation, useRouter } from "expo-router";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";
import { type } from "../theme/type";
import { focusData, transition } from "./Button";
import { Icon } from "./Icon";
import { useReducedMotion } from "./pointer";

const GLYPH = tokens.icon.sizes[2];
const INSET = (tokens.control.touch - GLYPH) / 2;
const web = Platform.OS === "web";

/** The pages Back can name, by route: the tab pages and the places that push further. */
const PAGES: Record<string, string> = {
  index: "Now",
  chats: "Chats",
  agents: "Agents",
  places: "Places",
  settings: "Settings",
  devices: "Devices",
  "vault/index": "Vault",
};

type NavState = { index?: number; routes: { name: string; state?: NavState }[] };

/** The page under this one in the stack (a tab page by its current tab), when it has a name. */
function usePreviousPage(): string | undefined {
  const nav = useNavigation();
  const st = nav.getState() as NavState | undefined;
  if (!st || !st.index) return undefined;
  let r = st.routes[st.index - 1];
  while (r?.state) r = r.state.routes[r.state.index ?? 0];
  return r ? PAGES[r.name] : undefined;
}

/**
 * Back (phone-shell, the pushed screen's nav row): the chev-l icon button at 44, with the previous
 * page's name at 17 when it fits in a third of the row (so the title keeps the rest), the chevron
 * alone when it doesn't. The page is the caller's `to`, else the one under this in the stack. Its
 * name is "Back to <page>", or "Back" when the page is unknown. With nothing to go back to (a link
 * opened cold) it goes to Now, and says so.
 */
export function BackButton({ to, testID = "back" }: { to?: string; testID?: string }) {
  const router = useRouter();
  const { color, scheme } = useTheme();
  const reduced = useReducedMotion();
  const { width } = useWindowDimensions();
  const [natural, setNatural] = useState<number | null>(null);
  const under = usePreviousPage();
  const cold = !router.canGoBack();
  const name = cold ? "Now" : (to ?? under);
  const room = (width - 2 * tokens.layout.gutterPhone) / 3 - tokens.control.touch;
  const shown = !!name && natural !== null && natural <= room;
  const a11y: Record<string, unknown> = web ? focusData(scheme) : {};
  return (
    <Pressable
      {...a11y}
      accessibilityRole="button"
      accessibilityLabel={name ? `Back to ${name}` : "Back"}
      testID={testID}
      onPress={() => (cold ? router.replace("/") : router.back())}
      style={(st) => {
        const hot = st.pressed || !!(st as { hovered?: boolean }).hovered;
        return [styles.box, { backgroundColor: hot ? color.hover : "transparent" }, web ? (transition(reduced) as ViewStyle) : null];
      }}
    >
      {(st) => {
        const ink = st.pressed || !!(st as { hovered?: boolean }).hovered ? color.text : color.text2;
        return (
          <>
            <Icon name="chev-l" size={GLYPH} color={ink} />
            {shown ? (
              <Text numberOfLines={1} style={[type.read, { color: ink }]}>
                {name}
              </Text>
            ) : null}
            {name ? (
              // The name at its natural width, unseen, to decide whether it fits.
              <View pointerEvents="none" aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.measure}>
                <View style={styles.measureRow}>
                  <Text style={type.read} onLayout={(e) => setNatural(e.nativeEvent.layout.width)}>
                    {name}
                  </Text>
                </View>
              </View>
            ) : null}
          </>
        );
      }}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // The chevron's square is 44 with the drawing centred; pulled left so the drawing sits on the gutter.
  box: {
    height: tokens.control.touch,
    minWidth: tokens.control.touch,
    paddingHorizontal: INSET,
    marginLeft: -INSET,
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space[1],
    borderRadius: tokens.radius.buttonTouch,
  },
  measure: { position: "absolute", width: 0, height: 0, overflow: "hidden", opacity: 0 },
  measureRow: { flexDirection: "row", width: 10000 },
});
