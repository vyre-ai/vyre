import { useLocalSearchParams } from "expo-router";
import { RealFlow } from "./RealFlow";

/** One Flow, from this Space's own flows. */
export default function FlowScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <RealFlow id={id ?? ""} />;
}
