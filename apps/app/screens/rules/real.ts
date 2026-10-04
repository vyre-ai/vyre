import { call } from "../../src/api/box";
import { rulesSource } from "./source";

export const { listReal, roleReal, setReal, enableReal, disableReal, proposeReal, acceptReal, dismissReal, removeReal } = rulesSource(call);
