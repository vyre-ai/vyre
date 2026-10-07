import SitesScreen from "../../screens/sites/SitesScreen";
import HiddenSites from "../../screens/sites/HiddenSites";
import { RC } from "../../screens/shell/rc";
export default RC.sites ? SitesScreen : HiddenSites;
