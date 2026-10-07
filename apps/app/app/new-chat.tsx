import { Redirect } from "expo-router";
export default function NewChat() { return <Redirect href={"/u/chats/new" as never} />; }
