import { Redirect } from "expo-router";
// A join link opens the onboarding flow at the Join step. The held invite link (src/shell/join-hold.js) is left in place for that step to read with takeJoin().
export default function InstallJoin() { return <Redirect href={"/onboard?path=join" as never} />; }
