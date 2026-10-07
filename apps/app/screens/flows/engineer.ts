import { callT as call } from "../../src/real/call-tool";
import { engineerSource } from "./engineer-source";

export const { check: checkFlowText, save: saveFlowText, code: flowCode } = engineerSource(call);
