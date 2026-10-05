// @ts-nocheck (copied from kernel/expr, where it is checked; the app does not import the kernel)
export class LanguageError extends Error {
  /**
   * @param {string} code stable machine code, for example "forbidden_syntax"
   * @param {string} message plain sentence for the author
   * @param {{ line?: number, col?: number, path?: string }} [where]
   */
  constructor(code, message, where = {}) {
    super(where.line ? `${message} (line ${where.line}, column ${where.col ?? 1})` : where.path ? `${message} (at ${where.path})` : message);
    this.name = "LanguageError";
    this.code = code;
    this.line = where.line;
    this.col = where.col;
    this.path = where.path;
  }
}
