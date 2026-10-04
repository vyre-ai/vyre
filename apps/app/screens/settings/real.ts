import { callT as call } from "../../src/real/call-tool";
import { settingsSource } from "./real-source";

export const { updateStatus, updateCheck, updateApply, pushSettings, pushSet, pushDevices, agentsList, agentsUsage, agentStop, agentResume, providers, identity, entries, replaceCode, removeEntry, types } = settingsSource(call);
