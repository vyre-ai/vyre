import { useLocalSearchParams } from "expo-router";
import { Page } from "../../../screens/places/Frame";
import { WhoPane, type WhoKind } from "../../../screens/chats/WhoPane";

/** /u/chats/who?kind=&id=: the side pane's content as a page, for where the shell has no right pane (a phone). */
export default function WhoPage() {
  const q = useLocalSearchParams<{ kind?: string; id?: string }>();
  const kind = (["assistant", "agent", "person", "group"].includes(String(q.kind)) ? q.kind : "agent") as WhoKind;
  return <Page title="Details" back="/u/chats?list=1"><WhoPane kind={kind} id={String(q.id ?? "")} /></Page>;
}
