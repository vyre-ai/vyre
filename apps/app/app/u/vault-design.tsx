import { useLocalSearchParams } from "expo-router";
import ShareDesign from "../../screens/vault/ShareDesign";
export default function Route() { const q = useLocalSearchParams<{ part?: string; open?: string }>(); return <ShareDesign part={q.part} open={q.open} />; }
