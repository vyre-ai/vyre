import { Redirect } from "expo-router";
import GlassScreen from "../../../screens/glass/GlassScreen";
import { RC } from "../../../screens/shell/rc";
import { allowsMock } from "@vyre/ui";
import SampleComputer from "../../../screens/glass/SampleComputer";

/** An agent's computer, full screen. The who pane's Computer tab opens it over the window. */
export default function GlassRoute() {
  return RC.glass ? <GlassScreen /> : allowsMock() ? <SampleComputer /> : <Redirect href={"/u/now" as never} />;
}
