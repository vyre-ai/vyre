import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme/theme";
import { tokens } from "../theme/tokens";
import { type } from "../theme/type";
import { StatusMark, type Status } from "./StatusMark";

/** The avatar spec's sizes: 20 (Mac rows), 24 (desktop rows), 32 (phone rows), 40 (detail headers); 34 is the phone header's person. */
export type AvatarSize = 20 | 24 | 32 | 34 | 40;

const TEXT = { 20: type.metaStrong, 24: type.metaStrong, 32: type.baseStrong, 34: type.baseStrong, 40: type.baseStrong } as const;
const RING = tokens.space[1];

/**
 * Who, as a neutral tile: an agent or a place is a rounded square (radius size / 4), the person a
 * circle. The initial is the name's first letter as the name is written. No colour per agent or
 * person; the only colour is the status mark on the corner, on a 2 px ring of the surface.
 */
export function Avatar({ name, size = 32, person, status, surface, hot }: {
  name: string;
  size?: AvatarSize;
  person?: boolean;
  status?: Status;
  /** The surface under the mark's ring (default bg). */
  surface?: string;
  /** Hovered or pressed, as the header's button to Places: the fill steps to `rule`. */
  hot?: boolean;
}) {
  const { color } = useTheme();
  const box = { width: size, height: size, borderRadius: person ? tokens.radius.full : size / 4 };
  return (
    <View style={box} accessibilityElementsHidden={!status} importantForAccessibility={status ? "auto" : "no-hide-descendants"}>
      <View style={[box, styles.tile, { backgroundColor: hot ? color.rule : color.hover }]}>
        <Text style={[TEXT[size], { color: color.text }]}>{(name || "?").slice(0, 1).toLowerCase()}</Text>
      </View>
      {status ? (
        <View style={[styles.mark, { backgroundColor: surface ?? color.bg }]}>
          <StatusMark status={status} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: "center", justifyContent: "center" },
  mark: { position: "absolute", right: -RING, bottom: -RING, padding: RING, borderRadius: tokens.radius.full },
});
