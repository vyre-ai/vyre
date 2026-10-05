import { useLocalSearchParams } from "expo-router";
import { ArtifactScreen } from "../../screens/chat-tools/ArtifactScreen";
export default function Route() { const { id, v } = useLocalSearchParams<{ id: string; v?: string }>(); return <ArtifactScreen id={String(id)} version={v ? Number(v) : undefined} />; }
