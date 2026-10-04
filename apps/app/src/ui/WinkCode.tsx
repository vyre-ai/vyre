import { useMemo } from "react";
import { View } from "react-native";
import { SvgXml } from "react-native-svg";
import { Chip, useUiTheme } from "@vyre/ui";
import { KINDS, winkCodeSvg } from "./wink-code-source.js";

/**
 * A Wink code: the drawn avatar with its ring of lines, unique per ticket, under the words for its kind ("Add your device", "Join <space>") with the kind's own
 * glyph and colour. There is no plain QR in the app (ADR 0043).
 */
export function WinkCode({ text, kind, space = "", size = 220 }: { text: string; kind: keyof typeof KINDS; space?: string; size?: number }) {
  const { resolved } = useUiTheme();
  const k = KINDS[kind];
  const xml = useMemo(() => winkCodeSvg(text, { scheme: resolved.scheme === "paper" ? "paper" : "dark", size }), [text, resolved.scheme, size]);
  const words = k.words(space);
  return (
    <View accessibilityRole="image" accessibilityLabel={`${words}, a Wink code`} className="items-center gap-s2">
      <Chip tone={k.tone} icon={k.glyph as never}>{words}</Chip>
      <View style={{ width: size, height: size, borderRadius: size / 2, overflow: "hidden" }}><SvgXml xml={xml} width={size} height={size} /></View>
    </View>
  );
}
