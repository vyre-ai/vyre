// @ts-check
// Node 22 prints "SQLite is an experimental feature" on every run that opens the store. The line
// lands in output other programs read (`vyre up --json`, `vyre call`), so it is dropped here, and
// only it: the box image does the same for every experimental warning with NODE_OPTIONS. It must
// run before node:sqlite is even linked, which a static import cannot promise (a builtin warns
// while the module graph links), so bin/vyre imports it first and everything else dynamically.

const emit = process.emitWarning;
/** @type {any} */ (process).emitWarning = function (/** @type {any} */ warning, /** @type {any[]} */ ...rest) {
  if (String((warning && warning.message) || warning).startsWith("SQLite is an experimental feature")) return;
  return emit.call(process, warning, ...rest);
};
