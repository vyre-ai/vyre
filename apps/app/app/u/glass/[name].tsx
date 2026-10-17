import { Redirect } from "expo-router";
import GlassScreen from "../../../screens/glass/GlassScreen";
import { RC } from "../../../screens/shell/rc";
import { allowsMock } from "@vyre/ui";
import SampleComputer from "../../../screens/glass/SampleComputer";

/** Screen Share (Glass) is 0.3.1: until then the address goes back to Now, and nothing links here. */
export default function GlassRoute() {
  return RC.glass ? <GlassScreen /> : allowsMock() ? <SampleComputer /> : <Redirect href={"/u/now" as never} />;
}
