import RulesScreen from "../../../screens/rules/RulesScreen";
import { ArchivedGate } from "../../../screens/settings/labs";

/** Archived (screens/settings/archived.js): opens only with Labs on. */
export default function Route() { return <ArchivedGate href="/u/settings/rules"><RulesScreen /></ArchivedGate>; }
