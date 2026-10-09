// The live screen inside a chat card, on the phone and desktop apps (native): Glass is web-only today, so the card says where to watch. The web build has the real one (LiveScreen.web.tsx).
import { Text } from "@vyre/ui";

export function LiveScreen({ computer }: { computer: string; private?: boolean; autoTake?: boolean; onHandedBack?: () => void }) {
  return <Text size="secondary" tone="muted">{`Watching ${computer}'s screen and taking over works in the web app for now. Open Vyre in a browser on your computer.`}</Text>;
}
