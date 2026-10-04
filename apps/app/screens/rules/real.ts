import { callT as call } from "../../src/real/call-tool";
import { rulesSource } from "./source";

export const { listReal, roleReal, setReal, enableReal, disableReal, proposeReal, acceptReal, dismissReal, removeReal } = rulesSource(call);
