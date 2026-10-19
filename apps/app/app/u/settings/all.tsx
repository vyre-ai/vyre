import { KeysScreen } from "../../../screens/settings/KeysScreen";
import { ArchivedGate } from "../../../screens/settings/labs";

/** Archived (screens/settings/archived.js): opens only with Labs on. */
export default function Route() { return <ArchivedGate href="/u/settings/all"><KeysScreen /></ArchivedGate>; }
