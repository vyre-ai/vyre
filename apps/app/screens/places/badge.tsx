// The space an item lives in, as the 16 emblem badge at the corner of its mark (never a text chip). Shown only when more than one space is on screen.
import { View } from "react-native";
import { SpaceMark, spaceRef, useUiTheme } from "@vyre/ui";
import { SPACES, useScope, type SpaceId } from "./scope";

/** A ringed 16 space emblem for a tile's `badge` slot, nothing when the page shows a single space. */
export function SpaceBadge({ sp }: { sp: SpaceId }) {
  const scope = useScope((s) => s.scope);
  const { color } = useUiTheme();
  if (scope !== "all") return null;
  return (
    <View style={{ borderRadius: 7, borderWidth: 2, borderColor: color["surface-2"], backgroundColor: color["surface-2"] }}>
      <SpaceMark space={spaceRef(SPACES[sp].name)} size={16} />
    </View>
  );
}
