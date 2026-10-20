import { View } from "react-native";
import { useUiTheme } from "../theme";
import { badgeLabel } from "../marks/provider.js";
import { ProviderLogo } from "./ProviderLogo";

/**
 * The small round tile that says which AI account wrote a reply, holding the provider's mark from the icon set (ProviderLogo) at 62 percent. Nothing is drawn without a provider. `onAvatar`
 * puts it at the avatar's lower right.
 */
export function ProviderBadge({ provider, model, size = 18, onAvatar = false }: { provider?: string | null; model?: string | null; size?: number; onAvatar?: boolean }) {
  const { color } = useUiTheme();
  if (!provider) return null;
  return (
    <View accessibilityRole="image" accessibilityLabel={badgeLabel(provider, model)}
      style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color["surface-2"] ?? color.hover, borderWidth: 1, borderColor: color["edge-strong"] ?? color.hover, alignItems: "center", justifyContent: "center" }, onAvatar ? { position: "absolute", right: -2, bottom: -2 } : null]}>
      <ProviderLogo provider={provider} size={Math.round(size * 0.62)} />
    </View>
  );
}
