// kernel/contracts/index.js: the constant tables behind the types. Data only, no logic.
// Every table is frozen. If you are about to put a function here, it belongs in kernel/ instead.

const f = list => Object.freeze([...list]);

export const CONTRACTS_VERSION = "0.1.0";

export const ACTOR_KINDS = f(["person", "agent", "device", "service", "automation"]);
export const SURFACES = f(["deck", "capsule", "cli", "mobile", "local", "mcp", "harness", "hook", "onboard", "link", "relay"]);
export const PRESENCE_SIGNERS = f(["secure_enclave", "tpm", "windows_hello", "strongbox", "webauthn_platform"]);

export const TRUST_ORDER = f(["untrusted", "external", "member", "system"]);
export const REDACTION_ORDER = f(["public", "internal", "pii", "privileged", "secret"]);

export const RISKS = f(["read", "write", "admin", "grant", "outward.send", "outward.pay", "outward.publish", "outward.delete", "outward.share"]);
export const OUTWARD_RISKS = f(["outward.send", "outward.pay", "outward.publish", "outward.delete", "outward.share"]);

export const EFFECTS = f(["allow", "deny", "ask"]);
export const REASON_CODES = f([
  "ok", "no_grant", "expired", "wrong_space", "wrong_node", "needs_presence", "needs_approval", "sealed", "tainted", "limit",
  "undeclared", "not_a_member", "chain_not_person", "revoked", "pattern_not_covered", "not_contained", "unknown_action", "runner_only", "bad_input", "not_found",
]);
export const VISIBILITY_KINDS = f(["space", "members", "actor", "subject", "owner"]);

export const TASK_STATES = f(["waiting", "ready", "working", "needs_check", "stuck", "done", "skipped"]);
export const TASK_OUTPUT_KINDS = f(["fields", "note", "draft", "sent", "decision", "file"]);
export const TASK_HOW = f(["template", "tailor", "assistant", "person"]);
export const TASK_SOURCES = f([
  "gate_hold", "grant_request", "pairing", "kit_install", "reveal_request", "continue_in_space", "flow_step", "assistant_request", "memory_proposal", "manual",
]);

/**
 * Who may perform each transition (contract 9.4). `guarded` true means the rule applies to a task with a checker, an
 * outward output or the stage's required flag; false means the task has none of those. Every other pair is not allowed.
 */
export const TASK_TRANSITIONS = Object.freeze([
  { from: "waiting", to: "ready", by: "dependencies_met" },
  { from: "ready", to: "working", by: "doer" },
  { from: "ready", to: "stuck", by: "assistant_or_detection" },
  { from: "ready", to: "skipped", by: "proposal_for_person_with_presence", guarded: true },
  { from: "ready", to: "skipped", by: "doer_or_person", guarded: false },
  { from: "working", to: "needs_check", by: "kernel_after_output_check", guarded: true },
  { from: "working", to: "done", by: "kernel_after_output_check", guarded: false },
  { from: "working", to: "stuck", by: "assistant_or_detection" },
  { from: "needs_check", to: "done", by: "checker_approval" },
  { from: "needs_check", to: "ready", by: "checker" },
  { from: "needs_check", to: "ready", by: "doer" },
  { from: "stuck", to: "ready", by: "responsible_person_or_person_with_presence" },
  { from: "stuck", to: "skipped", by: "proposal_for_person_with_presence", guarded: true },
  { from: "stuck", to: "skipped", by: "doer_or_person", guarded: false },
].map(r => Object.freeze(r)));

export const FIELD_KINDS = f([
  "text", "rich_text", "number", "money", "boolean", "date", "datetime", "choice", "multi_choice", "rating", "url", "link", "actor",
  "file", "address", "phones", "emails", "urls", "stage", "sealed",
]);
export const SEAL_CLASSES = f(["us-ssn", "us-itin", "us-ein", "card", "bank-account", "routing-number", "iban", "passport", "tax-id", "medical", "free"]);
export const STORE_ERROR_CODES = f([
  "not_found", "version_conflict", "invalid", "unknown_type", "unknown_field", "unsupported", "unavailable", "id_mismatch", "sealed_value_refused", "unique_violation",
]);

export const IDENTITY_KINDS = f(["user", "space", "device", "agent", "project", "session", "task"]);
export const NAMED_IDENTITY_KINDS = f(["user", "space"]);
export const KEYED_IDENTITY_KINDS = f(["user", "space", "device", "agent"]);
export const DEVICE_KINDS = f(["phone", "computer", "server", "storage_device"]);
export const OFFER_KINDS = f(["access", "approval", "compute", "storage"]);
export const DEVICE_OFFERS = Object.freeze({
  phone: f(["access", "approval"]), computer: f(["access", "approval", "compute"]), server: f(["compute", "storage"]), storage_device: f(["storage"]),
});

export const ROLE_IDS = Object.freeze(["owner", "admin", "manager", "member", "temp"]);
const bundle = (role, abilities, never, requires_scope, assistants_act_for_holder) =>
  Object.freeze({ role, abilities: Object.freeze(abilities), never: Object.freeze(never), requires_scope, assistants_act_for_holder });
const OWNER = ["space.delete", "space.move", "space.transfer", "space.root_key", "space.policy", "members.manage_all", "members.manage_below_admin", "devices.manage", "customize.definitions", "connectors.manage", "assistants.manage", "projects.create_run", "projects.set_team_tasks_checkers", "projects.approve_inside", "kits.use", "projects.work_member_of", "space.shared_by_policy"];
const ADMIN = OWNER.filter(a => !["space.delete", "space.move", "space.transfer", "space.root_key", "members.manage_all"].includes(a));
const MANAGER = ["projects.create_run", "projects.set_team_tasks_checkers", "projects.approve_inside", "kits.use", "projects.work_member_of", "space.shared_by_policy"];
export const ROLE_BUNDLES = Object.freeze({
  owner: bundle("owner", OWNER, [], false, true),
  admin: bundle("admin", ADMIN, ["space.delete", "space.move", "space.transfer", "space.root_key"], false, true),
  manager: bundle("manager", MANAGER, ["customize.definitions", "members.manage_all", "members.manage_below_admin"], false, true),
  member: bundle("member", ["projects.work_member_of", "space.shared_by_policy"], ["customize.definitions", "members.manage_all", "members.manage_below_admin"], false, true),
  temp: bundle("temp", ["scoped.work"], ["space.shared_by_policy", "customize.definitions"], true, false),
});
