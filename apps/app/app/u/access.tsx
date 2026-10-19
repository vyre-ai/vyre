import { AccessScreen } from "../../screens/devices/AccessScreen";
import { ArchivedGate } from "../../screens/settings/labs";

/** Archived (screens/settings/archived.js): opens only with Labs on. */
export default function Route() { return <ArchivedGate href="/u/access"><AccessScreen /></ArchivedGate>; }
