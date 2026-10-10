// J2 Intake to signed engagement (team/0.3.1/JOURNEYS.md): a client record -> a project from the Estate template -> the intake stage done -> the stage move runs the signing Flow -> Documents fills the
// engagement letter from the record -> PDF -> Comms holds the email at the Gate -> ONE yes -> the signer opens the page as a stranger -> signed -> the signed copy is filed on the client -> the record moves to
// the signed stage -> the timeline says each step in plain lines -> exactly one email went out.
// Walked as the owners' real-daemon tests, each against the real thing it is about (a real DocuSeal in Docker, a real IMAP/SMTP mail server, the real relay, tunnel end and gate, a real Chrome as the signer,
// the real Gotenberg): a FAIL names the owner. They need Docker and run only where VYRE_APPMODS_LIVE=1 is allowed (a test box or a CI runner). The Estate Kit's own matter is one of the cases (Engagement is the stage that sends the engagement letter), and the signed copy rides the same yes (`with`): one yes for both emails.
import { walkTestFile } from "./lib/testfile.mjs";

// the live tests start a real daemon of their own; the journey says "plain", so they keep the small built-in store. On a runner with Docker the default would start a Twenty for each, whose types are not readable until it is up ("the type definitions could not be read, so the links were not checked").
const LIVE = { VYRE_APPMODS_LIVE: "1", VYRE_STORE: "sqlite" };

export default {
  id: "J2", title: "Intake to signed engagement", owner: "operations", world: "own", store: "plain",
  /** @param {any} _w @param {ReturnType<typeof import("./lib/journey.mjs").stepper>} J */
  async steps(_w, J) {
    // the signing Flow on the Kit's own people (a linked Contact), the yes, and the stage that moves
    await walkTestFile(J, "core/documents/signing.test.js", "operations").report();
    // a real DocuSeal: the document sent from a stage on one yes, mail through a real mail server, the signature as a stranger, the record moved on, the signed copy filed and sent on the second yes
    await walkTestFile(J, "core/appmods/docuseal-live.test.js", "operations", { env: LIVE, timeoutMs: 15 * 60_000 }).report();
    // a real Chrome signs as a stranger through the real relay, tunnel end and gate, and declines another
    await walkTestFile(J, "core/appmods/outside-signer.live.test.js", "operations", { env: LIVE, timeoutMs: 15 * 60_000 }).report();
    // the PDF of a filled engagement letter, made by the installable converter
    await walkTestFile(J, "core/appmods/pdf-app-live.test.js", "operations", { env: LIVE, timeoutMs: 10 * 60_000 }).report();
  },
};
