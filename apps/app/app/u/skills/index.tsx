import { allowsMock, Card, EmptyState } from "@vyre/ui";
import { RealSkills } from "../../../screens/skills/RealSkills";
import { Frame } from "../../../screens/places/Frame";

function MockSkills() {
  return (
    <Frame back="/u/playbooks" title="Skills and plugins" sub="Sample build: connect a box to manage the library.">
      <Card><EmptyState title="Skills need a box" body="Install and pair Vyre to browse, draft and approve skills." /></Card>
    </Frame>
  );
}

export default function SkillsScreen() {
  return allowsMock() ? <MockSkills /> : <RealSkills />;
}
