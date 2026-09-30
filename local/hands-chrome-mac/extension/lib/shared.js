// @ts-check
// shared: the one place the extension reaches for the wire format and the redactor. The files
// live in extension/shared/ (inside the folder Chrome loads, which a worker requires) and the
// module and the native host import the same copies, so nothing can drift.

export * as proto from "../shared/proto.js";
export * as redact from "../shared/redact.js";
