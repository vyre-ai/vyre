import { Redirect } from "expo-router";

/** The old Places sheet: Vault, Devices and Settings are in the shell's More and Settings now. */
export default function Places() { return <Redirect href={"/u/settings" as never} />; }
