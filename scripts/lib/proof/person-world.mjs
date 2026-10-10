// @ts-check
// A world with a real person, for every proof that needs the owner's yes: design's run-switch walk, release's journeys, chat's start-a-chat step, Publish.
//
//   const pw = await personWorld({ name: "alex", kind: "daemon" });      // or kind: "box" (a development-build installer box; Linux with Docker, VYRE_JOURNEY_BOX=1)
//   await pw.call("spaces.devices.list");                                  // a tool call as the person, over the app's paired session; a call that asks for the person's yes gets it
//   const r = await pw.yesFor(sign);                                       // the proof header for an act the server asked to be confirmed (what the phone's key signs)
//   await pw.close();
//
// What it builds: the repo's own names Worker and relay stand-ins, one person with an identity under the chosen Vyre name, the app's own modules driven headless, and a REAL server that person has added
// and adopted the way the app's Add a server does: `daemon` is a real vyred in this process with a development sealing process that took the owner's stand-in key before pairing; `box` is the real installer's
// box built as a DEVELOPMENT build (VYRE_DEV_SIGN=unsigned) whose sealer takes the stand-in key through the product's own identity and presence calls (spaces.identity.entry.add, spaces.presence.begin and
// recover). What this cannot cover: the release signature and a hardware key (a packaged build ignores every developer switch, kernel/devbuild.js). Throwaway machines only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRun } from "./run.mjs";
import { bringUp } from "../../journeys/lib/world.mjs";

/**
 * @param {{ name?: string, kind?: "daemon" | "box", store?: "plain" | "records", out?: string, run?: ReturnType<typeof createRun> }} [o]
 */
export async function personWorld(o = {}) {
  const kind = o.kind || "daemon";
  const out = o.out || fs.mkdtempSync(path.join(os.tmpdir(), "person-world-"));
  const run = o.run || createRun({ out });
  const w = await bringUp({ run, out, kind, store: o.store || "plain", ...(kind === "box" ? { devBuild: true } : {}), ...(o.name ? { person: o.name } : {}) });
  if (!w.ready) { await w.stop().catch(() => {}); throw new Error(`the ${kind} world did not come up: ${run.results.filter(r => r.ok === false).map(r => `${r.name}: ${r.why || ""}`).join(" | ").slice(0, 500)}`); }
  const personId = w.mac.identity.id;
  const srv = w.srv;
  if (kind === "box") await enrolStandIn(w);
  return {
    world: w, run, out, kind, person: w.person, personId, server: srv,
    /** A tool call as the person; a call the server answers presence_required to is retried with the person's yes (the stand-in key signs exactly what the card shows). @param {string} tool @param {any} [input] */
    call: (tool, input = {}) => w.call(tool, input),
    /** The proof header (base64url) for an act the server asked to be confirmed. @param {{ op: string, space: string, fields: Record<string, any> }} sign */
    yesFor: sign => srv.yesFor(personId)(sign),
    /** The server's own operator terminal (the machine's console), for what no paired person does. @param {string} tool @param {any} [input] */
    operator: (tool, input = {}) => w.operator(tool, input),
    mac: w.mac,
    close: () => w.stop(),
  };
}

/** A development-build box: the stand-in owner key goes on the identity list, then into the box's sealer, through the product's own calls (trust's route). @param {any} w */
async function enrolStandIn(w) {
  const sg = w.srv.ownerSigner;
  assert.ok(sg, "the box server has an owner signer (a development-build box)");
  const spki = sg.enrolment.spki;
  await w.call("spaces.identity.entry.add", { kind: "device", publicKey: Buffer.from(spki, "base64").toString("base64url"), label: "stand-in owner key" });
  const begun = await w.call("spaces.presence.begin", { key_id: sg.enrolment.key_id, spki });
  await w.call("spaces.presence.recover", { key_id: sg.enrolment.key_id, spki, signer: "software", token: begun.token });
}
