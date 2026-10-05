import { View } from "react-native";
import { SvgXml } from "react-native-svg";
import { Text } from "./Text";
import { useUiTheme } from "../theme";
import { badgeLabel, providerArt, providerMono } from "../marks/provider.js";

/**
 * The small round tile that says which AI account wrote a reply, holding the provider's own mark at 62 percent. Nothing is drawn without a provider. `onAvatar` puts it at the avatar's lower right.
 */
export function ProviderBadge({ provider, model, size = 18, onAvatar = false }: { provider?: string | null; model?: string | null; size?: number; onAvatar?: boolean }) {
  const { color, resolved } = useUiTheme();
  if (!provider) return null;
  const art = providerArt(provider, resolved.scheme === "paper" ? "paper" : "dark");
  const inner = Math.round(size * 0.62);
  return (
    <View accessibilityRole="image" accessibilityLabel={badgeLabel(provider, model)}
      style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color["surface-2"] ?? color.hover, borderWidth: 1, borderColor: color["edge-strong"] ?? color.hover, alignItems: "center", justifyContent: "center" }, onAvatar ? { position: "absolute", right: -2, bottom: -2 } : null]}>
      {art ? <SvgXml xml={art} width={inner} height={inner} /> : <Text strong size="caption" tone="muted" style={{ fontSize: Math.max(7, Math.round(size * 0.44)) }}>{providerMono(provider)}</Text>}
    </View>
  );
}
