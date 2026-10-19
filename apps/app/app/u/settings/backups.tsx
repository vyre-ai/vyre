import { Redirect } from "expo-router";

/** Merged (screens/settings/archived.js): the backups list is on Updates and backups now. */
export default function Route() { return <Redirect href={"/u/settings/updates" as never} />; }
