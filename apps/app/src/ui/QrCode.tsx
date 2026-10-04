import { useMemo } from "react";
import { View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { qrMatrix } from "@vyre/relay-client/qr.js";

/** The QR matrix for a text, or null when it cannot be drawn (not printable ASCII, or longer than the encoder takes). */
export function qrFor(text: string): boolean[][] | null {
  try { return qrMatrix(text); } catch { return null; }
}

/**
 * A QR code for a text, drawn as one path on a white ground with a four-module quiet zone, so a phone's camera reads it on a dark theme too.
 * Draws nothing when the text cannot be encoded: the caller shows the text beside it.
 */
export function QrCode({ text, size = 200, label = "QR code" }: { text: string; size?: number; label?: string }) {
  const m = useMemo(() => qrFor(text), [text]);
  if (!m) return null;
  const quiet = 4;
  const n = m.length + quiet * 2;
  let d = "";
  m.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + quiet} ${y + quiet}h1v1h-1z`; }));
  return (
    <View accessibilityLabel={label} accessibilityRole="image" style={{ width: size, height: size, alignSelf: "center" }}>
      <Svg width="100%" height="100%" viewBox={`0 0 ${n} ${n}`}>
        <Rect width={n} height={n} fill="#ffffff" />
        <Path d={d} fill="#141311" />
      </Svg>
    </View>
  );
}
