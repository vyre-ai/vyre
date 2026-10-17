import { Redirect } from "expo-router";
import { useUiTheme } from "@vyre/ui";
import { SettingsHome } from "../../../screens/settings/SettingsHome";
import { SETTINGS_ITEMS } from "../../../screens/shell/settings-items.js";

/** Settings. The sidebar lists the sections, so on a wide screen this opens the first one; a phone has no sidebar, so there it is the list of sections. */
export default function Route() {
  const { phone } = useUiTheme();
  return phone ? <SettingsHome /> : <Redirect href={SETTINGS_ITEMS[0].href as never} />;
}
