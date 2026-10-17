// Built-in Flow call-step shortcuts the builder treats like first-class steps (not picked from flows.actions).
// Kept in the app package so Expo export does not reach into core/.
export const SPECIAL_BUILDER_ACTIONS = Object.freeze([
  "documents.generate",
  "work.start-project",
  "comms.send",
  "comms.email",
]);
