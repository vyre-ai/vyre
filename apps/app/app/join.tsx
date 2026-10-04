// vyre://join?link=<https join link>: the web join page's "Open in Vyre". The link is verified by the box (spaces.invites.preview) on the next screen, which shows the card; nothing is joined from here.
import { Redirect, useLocalSearchParams } from "expo-router";
import { joinTarget } from "../src/shell/join-link.js";

export default function JoinLink() {
  const { link } = useLocalSearchParams<{ link?: string }>();
  return <Redirect href={joinTarget(link) as never} />;
}
