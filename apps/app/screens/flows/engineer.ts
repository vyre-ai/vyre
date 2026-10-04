import { call } from "../../src/api/box";
import { engineerSource } from "./engineer-source";

export const { check: checkFlowText, save: saveFlowText } = engineerSource(call);
