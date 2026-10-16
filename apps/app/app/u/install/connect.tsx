import { Redirect } from "expo-router";

// Add a computer is the first-run flow: a space address and the master password.
export default function InstallConnect() { return <Redirect href={"/onboard?path=computer" as never} />; }
