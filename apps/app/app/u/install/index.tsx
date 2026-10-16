import { Redirect } from "expo-router";
// The first run is at /onboard (screens/first-run); this old address leads there.
export default function Install() { return <Redirect href="/onboard" />; }
