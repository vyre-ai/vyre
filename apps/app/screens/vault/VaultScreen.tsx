import { useMemo } from "react";
import { allowsMock } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import VaultRedesign from "./VaultRedesign";
import { realData, sampleData } from "./redesign-data";

/** The sample world in a mock build; the vyred's own Vault (Space) and the member's own vault (Mine) everywhere else. */
export default function VaultScreen() {
  const data = useMemo(() => (allowsMock() ? sampleData() : realData(callT)), []);
  return <VaultRedesign data={data} />;
}
