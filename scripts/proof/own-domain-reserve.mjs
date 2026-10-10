// @ts-check
// Reserve a throwaway name on the REAL names directory the way a person's install does (the app's Add a server), install a box from this checkout against the real directory and relay, adopt it,
// and ask it for the two DNS records an own domain needs (names.domain.check, and appmods.domain.add when a signing app runs). Runs on a throwaway test box only (VYRE_JOURNEY_BOX=1); the box and the
// name stay up until the DNS proof is done. Prints NAME= and the records; nothing secret.
//   VYRE_JOURNEY_BOX=1 node scripts/proof/own-domain-reserve.mjs <own host, e.g. own-proof.example.com>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../lib/proof/app.mjs";
import { startInstallerServer } from "../lib/proof/server-installer.mjs";
import { LIVE } from "../lib/proof/live.mjs";

const host = process.argv[2] || "own-proof.example.com";
const out = fs.mkdtempSync(path.join(os.tmpdir(), "own-domain-"));
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const person = `opsown${Math.random().toString(36).slice(2, 7)}`;
const mac = createApp({ label: "Ops Mac", dir: path.join(out, "mac"), directory: LIVE.names, relay: LIVE.relay });
const reservation = await mac.reserve(person);
const me = await mac.becomeYourself({ name: reservation.name, code: reservation.code });
console.log(`NAME=${reservation.name}`);
const flow = mac.addServer();
await flow.begin("plain");
const srv = await startInstallerServer({ dir: path.join(out, "server"), repo: REPO, code: flow.state.code, relayForServer: LIVE.relay, namesForServer: LIVE.names, store: "plain" });
await mac.until(() => flow.state.stage === "found" || flow.state.stage === "stopped", 420_000, "the app to find the server").catch(e => { console.log("INSTALL LOG TAIL:\n" + fs.readFileSync(path.join(out, "server", "install.log"), "utf8").split("\n").slice(-25).join("\n")); throw e; });
if (flow.state.stage !== "found") throw new Error(`not found: ${flow.state.error && flow.state.error.message}`);
console.log(`words match: ${flow.state.box.words.join(" ") === await srv.words()}`);
await flow.confirmWords();
if (flow.state.stage !== "done") throw new Error(`pairing stopped: ${flow.state.error && flow.state.error.message}`);
await mac.openSession();
// a Space listed by this server under a name: the directory then knows which box serves <name>.vyre.run (what names.domain.check and the DNS lines need)
const team = await mac.createTeamSpace(`firm${person.slice(-5)}`);
console.log(`SPACE=${team.space} LABEL=${team.label}`);
const call = async (/** @type {string} */ tool, /** @type {any} */ input) => { try { return await mac.callTool(tool, input); } catch (e) { return { error: String(/** @type {Error} */ (e).message) }; } };
console.log("identity", me.id ? "ok" : "none");
console.log("names.serve:", JSON.stringify(await call("names.serve", { name: team.label })));
console.log("names.domain.check:", JSON.stringify(await call("names.domain.check", { domain: host })));
console.log("appmods.domain.add:", JSON.stringify(await call("appmods.domain.add", { host })));
console.log("names.status:", JSON.stringify(await call("names.status", {})).slice(0, 600));
mac.close();
process.exit(0);
