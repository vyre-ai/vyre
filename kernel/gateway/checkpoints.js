// The actions behind a session's checkpoint store (core/runner/checkpoint-store.js): reading and writing one session's transcript, files and checkpoints.
// They are registered here so the authorizer knows them (an unregistered action answers unknown_action; two segments only, the grant syntax allows no more and every store call is not_found). They are in NO role:
// a person's role never reaches a session's history; the grant is made per session, to that session's own chain, on `vyre://<space>/session/<id>`.
export const CHECKPOINT_ACTIONS = Object.freeze([
  { action: "checkpoint.write", resource_type: "session", risk: "write", label: "save a session's checkpoints", gloss: "Save one session's transcript, files and turn checkpoints." },
  { action: "checkpoint.read", resource_type: "session", risk: "read", label: "read a session's checkpoints", gloss: "Read one session's saved transcript, files and checkpoints to continue it." },
].map(a => Object.freeze(a)));
