import { useLocalSearchParams } from "expo-router";
import { InstallScreen } from "../screens/install/InstallScreen";
import { joinLink } from "../src/shell/join-link.js";

/**
 * `vyre://join?link=<link>` on the phone, `/app/join?link=...` on the web: the invite card for that link (spaces.invites.preview), then join.
 * Only an https link of a space's own join path goes on; anything else lands on the plain Join screen with nothing filled in.
 */
export default function Join() {
  const { link } = useLocalSearchParams<{ link?: string | string[] }>();
  return <InstallScreen start="join" link={joinLink(link) ?? undefined} />;
}
