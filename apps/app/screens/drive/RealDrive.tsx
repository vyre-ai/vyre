// Drive from the real vyred: the Space's own Drive (versioned, permissioned files) and the links made from it. The box's shared folders (the mounted VyreDrive) are gone until the mounted Drive returns in 0.3.0.
import { useState } from "react";
import { Frame } from "../places/Frame";
import { SpaceDrive } from "./SpaceDrive";
import { SharedLinks } from "./SharedLinks";

export default function RealDrive() {
  const [made, setMade] = useState(0);
  return (
    <Frame title="Drive" sub="The space's files with their versions.">
      <SpaceDrive onLink={() => setMade((n) => n + 1)} />
      <SharedLinks refresh={made} />
    </Frame>
  );
}
