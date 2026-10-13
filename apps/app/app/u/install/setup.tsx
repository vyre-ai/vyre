import { Redirect } from "expo-router";
// The old setup page (with its Lumen download) is replaced by the onboarding flow.
export default function InstallSetup() { return <Redirect href="/onboard" />; }
