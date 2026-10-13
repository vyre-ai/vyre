import { Redirect } from "expo-router";
/** /u/settings/engineer is the one Engineer chat's old place: it goes to /u/engineer. */
export default function Route() { return <Redirect href={"/u/engineer" as never} />; }
