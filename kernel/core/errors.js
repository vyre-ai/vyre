// kernel/core/errors.js: the one typed error every kernel call throws (contracts common.d.ts KernelError).
export class KernelError extends Error {
  /** @param {string} code stable and lowercase @param {string} message @param {string} [hidden_reason] kept in the log, never shown to the caller */
  constructor(code, message, hidden_reason) {
    super(message);
    this.name = "KernelError";
    this.code = code;
    if (hidden_reason) this.hidden_reason = hidden_reason;
  }
}
