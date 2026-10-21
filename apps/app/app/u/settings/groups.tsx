import { Redirect } from "expo-router";

/** Merged into People and roles. */
export default function Route() { return <Redirect href={"/u/settings/roles" as never} />; }
