import { Redirect } from "expo-router";
import GlassScreen from "../../../screens/glass/GlassScreen";
import { RC } from "../../../screens/shell/rc";

// Glass is 0.3.1 (Screen Share); until then its page is not reachable.
export default function Route() { return RC.glass ? <GlassScreen /> : <Redirect href={"/u/now" as never} />; }
