import { Redirect } from "expo-router";

/** Add a server is the first-run create path: a Linux server or an always-on Mac, then the one install command. */
export default function SetupServer() { return <Redirect href={"/onboard?path=create" as never} />; }
