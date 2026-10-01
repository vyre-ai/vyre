// What does vyred take this process for? Asks one person-only tool as the CLI and prints one line: PERSON, or MODEL and the refusal.
// Run by the probe from wherever a bypass puts it. Needs VYRE_HOME for the vyred under test.
import { call } from "../../../core/daemon/client.js";
const r = await call("network.guests.list", {}, { caller: "cli" });
const ok = r && r.data !== undefined && !r.error;
console.log(ok ? "PERSON" : `MODEL ${r && r.error ? r.error.code : "no answer"}`);
