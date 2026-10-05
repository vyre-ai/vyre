import { callT as call } from "../../src/real/call-tool";
import { connectionsSource } from "./source";

export const connections = connectionsSource(call);
