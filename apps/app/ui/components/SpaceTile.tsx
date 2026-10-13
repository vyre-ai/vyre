import { useState } from "react";
import { Image, View } from "react-native";
import { useUiTheme } from "../theme";
import { Text } from "./Text";
import { spaceTile, TILE_PALETTE } from "../marks/space-tile.js";
import { useSpaceLogos } from "../marks/useSpaceLogos";

export type SpaceTileSize = 12 | 14 | 16 | 20 | 24 | 28 | 32 | 36 | 40 | 44 | 56;

/**
 * A space's mark: the person's logo cropped to a rounded square (or a circle), else a monogram of the space's initials on a calm tinted tile from the
 * curated palette. The tile follows the space's id, so it never changes on a rename. A logo that fails to load falls back to the monogram.
 */
export function SpaceTile({ space, size = 32, shape = "squircle" }: { space: { id: string; name: string; logo?: string | null }; size?: SpaceTileSize; shape?: "squircle" | "round" }) {
  const { resolved } = useUiTheme();
  const [failed, setFailed] = useState(false);
  const kept = useSpaceLogos((s) => s.logos[space.id]);
  const t = spaceTile({ ...space, logo: space.logo ?? kept }, { failed });
  const radius = shape === "round" ? size : Math.round(size * 0.28);
  const box = { width: size, height: size, borderRadius: radius, overflow: "hidden" as const };
  if (t.kind === "logo") {
    return <View accessibilityLabel={space.name} style={box}><Image source={{ uri: t.uri }} onError={() => setFailed(true)} resizeMode="cover" style={{ width: size, height: size }} /></View>;
  }
  const c = TILE_PALETTE[t.palette][resolved.scheme === "paper" ? "paper" : "dark"];
  return (
    <View accessibilityLabel={space.name} style={[box, { backgroundColor: c.bg, alignItems: "center", justifyContent: "center" }]}>
      <Text strong style={{ color: c.ink, fontSize: Math.round(size * (t.initials.length > 1 ? 0.38 : 0.46)), lineHeight: Math.round(size * 0.5), letterSpacing: 0.2 }}>{t.initials}</Text>
    </View>
  );
}
