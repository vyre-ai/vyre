import { call } from "../../src/api/box";
import { settingsSource } from "./real-source";

export const { updateStatus, updateCheck, updateApply, pushSettings, pushSet, pushDevices, agentsList, agentsUsage, agentStop, agentResume, providers, identity, entries, replaceCode, removeEntry, types } = settingsSource(call);
