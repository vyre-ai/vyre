import { useLocalSearchParams } from "expo-router";
import { InstallScreen } from "../screens/install/InstallScreen";

/** `vyre://join?link=<invite link>` on the phone, `/app/join?link=...` on the web: the invite card for that link (spaces.invites.preview), then join. One handler for both. */
export default function Join() {
  const { link } = useLocalSearchParams<{ link?: string | string[] }>();
  const l = Array.isArray(link) ? link[0] : link;
  return <InstallScreen start="join" link={l} />;
}
