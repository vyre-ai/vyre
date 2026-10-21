import { Redirect } from "expo-router";

/** Merged into Devices and computers. */
export default function Route() { return <Redirect href={"/u/settings/devices" as never} />; }
