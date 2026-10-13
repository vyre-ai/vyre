import { Redirect } from "expo-router";
// The first run is the onboarding flow (screens/onboard); this old address leads there.
export default function Install() { return <Redirect href="/onboard" />; }
