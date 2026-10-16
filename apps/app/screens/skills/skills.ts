import { callT as call } from "../../src/real/call-tool";
import { skillsSource } from "./skills-source";

export const { browse, versions, get, draft, approve, rollback } = skillsSource(call);
