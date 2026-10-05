// The artifact's own page. On a phone there is no safe frame yet, so the page says where it opens.
import { Text } from "@vyre/ui";
export function ArtifactFrame(_: { id: string; v: number; title: string; kind: string; onLeft?: () => void }) {
  return <Text tone="muted">This opens in the web app, where it runs in its own sealed frame.</Text>;
}
