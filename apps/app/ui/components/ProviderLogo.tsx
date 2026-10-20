import { Text } from "./Text";
import { Icon, type IconName } from "./Icon";
import { providerIcon, providerMono } from "../marks/provider.js";

/**
 * An AI provider's brand mark from the app's icon set (logo-claude, logo-openai, logo-grok, logo-openrouter; the key icon for OpenAI-compatible), monochrome in a theme ink so it reads in
 * light and dark. Every provider is drawn the same way. An unknown provider gets its monogram. Decorative: the row around it names the provider.
 */
export function ProviderLogo({ provider, size = 20, tone = "text" }: { provider: string; size?: number; tone?: string }) {
  const icon = providerIcon(provider);
  if (icon) return <Icon name={icon as IconName} size={size} tone={tone} />;
  return <Text strong size="caption" tone="muted" style={{ fontSize: Math.max(7, Math.round(size * 0.6)) }}>{providerMono(provider)}</Text>;
}
