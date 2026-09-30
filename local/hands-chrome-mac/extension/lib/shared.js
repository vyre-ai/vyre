// @ts-check
// shared: the one place the extension reaches for the wire format and the redactor.
//
// An MV3 worker can only import files inside the folder Chrome loaded, and proto.js / redact.js
// live in ../shared (they are also used by the module and the native host). The installer copies
// that folder to extension/shared/ when it packs the extension; until then this file is the single
// line to change, so no capability ever hard-codes the path.

export * as proto from "../../shared/proto.js";
export * as redact from "../../shared/redact.js";
