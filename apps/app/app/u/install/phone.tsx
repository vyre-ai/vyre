import { Redirect } from "expo-router";

// Add a phone is the first-run flow. The link the phone opens is made by onboard.phone.add.
export default function InstallPhone() { return <Redirect href={"/onboard?path=phone" as never} />; }
