import { Redirect } from "expo-router";

/** The app opens on Now in the one shell (@vyre/ui, under /u): the phone's tab bar and the web's rail are the same Shell. The old tab screens are retired. */
export default function Index() { return <Redirect href={"/u/now" as never} />; }
