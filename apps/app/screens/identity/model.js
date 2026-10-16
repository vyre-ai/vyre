// The identity screens call identity.create, identity.unlock and identity.migrate.
// onboard.person.create calls identity.create as well. One tool, one flow.

const NAME = /^[a-z][a-z0-9-]{2,19}$/;

/** @param {unknown} pw */
export function passwordOk(pw) {
  const s = String(pw ?? "");
  if (s.length < 12) return "short";
  if (s.length > 256) return "long";
  return "ok";
}

/** @param {unknown} a @param {unknown} b */
export function pairOk(a, b) {
  const p = passwordOk(a);
  if (p !== "ok") return p;
  if (a !== b) return "differ";
  return "ok";
}

export const SAY = {
  short: "Choose a master password of at least 12 characters. A phrase of four words works well.",
  long: "That master password is too long. Choose one of 256 characters or fewer.",
  differ: "The two passwords do not match. Type the same one in both.",
  name: "Use 3 to 20 letters, numbers or hyphens, starting with a letter.",
  empty: "Enter your recovery key on this device.",
};

/**
 * Create a username. The password is entered on the device and sent only to identity.create.
 * @param {{ username?: unknown, password?: unknown, confirm?: unknown }} o
 */
export function createCall(o) {
  const name = String(o.username ?? "").trim().toLowerCase();
  if (!NAME.test(name)) return { error: "name" };
  const pair = pairOk(o.password, o.confirm);
  if (pair !== "ok") return { error: pair };
  return { tool: "identity.create", input: { username: name, password: String(o.password) } };
}

/** @param {{ password?: unknown }} o */
export function unlockCall(o) {
  const p = passwordOk(o.password);
  if (p !== "ok") return { error: p };
  return { tool: "identity.unlock", input: { password: String(o.password) } };
}

/** @param {{ password?: unknown, confirm?: unknown }} o */
export function migrateCall(o) {
  const pair = pairOk(o.password, o.confirm);
  if (pair !== "ok") return { error: pair };
  return { tool: "identity.migrate", input: { password: String(o.password) } };
}

/**
 * A recovery key is checked first. The device shows a confirmation, and only that step sends confirm.
 * @param {{ recovery?: unknown, confirmed?: boolean }} o
 */
export function recoveryCall(o) {
  const code = String(o.recovery ?? "").trim();
  if (!code) return { error: "empty" };
  if (o.confirmed) return { tool: "identity.unlock", input: { recovery: code, confirm: true }, step: "done" };
  return { tool: "identity.unlock", input: { recovery: code }, step: "confirm" };
}
