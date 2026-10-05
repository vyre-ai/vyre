import { callT as call } from "../../src/real/call-tool";
import { SURFACE } from "../../src/state/live";
import { findSource } from "./source";

export const find = findSource(call, SURFACE);
