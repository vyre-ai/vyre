import { callT as call } from "../../src/real/call-tool";
import { skillsSource } from "./skills-source";

export const { browse, versions, get, draft, approve, rollback, decline } = skillsSource(call);
export type { SkillRow, SkillVersion, BrowsePack } from "./skills-source";
