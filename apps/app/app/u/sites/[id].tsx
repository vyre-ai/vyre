import SiteScreen from "../../../screens/sites/SiteScreen";
import HiddenSites from "../../../screens/sites/HiddenSites";
import { RC } from "../../../screens/shell/rc";
export default RC.sites ? SiteScreen : HiddenSites;
