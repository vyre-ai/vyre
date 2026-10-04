import { useLocalSearchParams } from "expo-router";
import { InstallScreen } from "../../../screens/install/InstallScreen";
export default function InstallJoin() {
  const { link } = useLocalSearchParams<{ link?: string }>();
  return <InstallScreen start="join" inviteLink={typeof link === "string" && link ? link : undefined} />;
}
