// Drive from the real vyred: the Space's own Drive (versioned, permissioned files). The box's shared folders (the mounted VyreDrive) are gone until the mounted Drive returns in 0.3.0.
import { Frame } from "../places/Frame";
import { SpaceDrive } from "./SpaceDrive";

export default function RealDrive() {
  return (
    <Frame title="Drive" sub="The space's files with their versions.">
      <SpaceDrive />
    </Frame>
  );
}
