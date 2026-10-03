import { View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { useUiTheme } from "../theme";

const rnd = (i: number) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

/**
 * The Wink ring a device or an invitation shows so a phone can scan it: two rings of dots round a clear centre, drawn from a seed.
 * It fills its parent (the parent sets the size with a width token such as w-ring). Placeholder until the generated mark families
 * replace it; the contract (a square, scannable, one ink) stays.
 */
export function Ring({ seed = 3, tone = "text", label = "Wink ring" }: { seed?: number; tone?: string; label?: string }) {
  const { color } = useUiTheme();
  const ink = color[tone] ?? color.text;
  const n = 150, c = n / 2;
  const dots: React.ReactNode[] = [];
  [[0.82, 36], [0.7, 36]].forEach(([r, count], ri) => {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 - Math.PI / 2;
      const l = Math.floor(rnd(i + ri * 50 + seed * 7) * 4);
      dots.push(<Circle key={`${ri}-${i}`} cx={c + Math.cos(a) * c * r} cy={c + Math.sin(a) * c * r} r={1.1 + l * 0.6} fill={ink} opacity={l > 1 ? 1 : 0.5} />);
    }
  });
  return (
    <View accessibilityLabel={label} accessibilityRole="image" className="aspect-square w-full">
      <Svg width="100%" height="100%" viewBox={`0 0 ${n} ${n}`}>
        <Circle cx={c} cy={c} r={c - 1} fill={color["surface-2"]} stroke={color["edge-strong"]} />
        {dots}
        <Circle cx={c} cy={c} r={c * 0.44} fill={ink} opacity={0.22} />
        <Circle cx={c} cy={c} r={c * 0.44} fill="none" stroke={ink} strokeWidth={1.5} />
      </Svg>
    </View>
  );
}
