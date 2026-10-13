import { allowsMock } from "@vyre/ui";
import RealVault from "./RealVault";
import VaultRedesign from "./VaultRedesign";

/** The sample world in a mock build; the vyred's own Vault everywhere else. */
export default function VaultScreen() {
  return allowsMock() ? <VaultRedesign /> : <RealVault />;
}
