// kernel/expr/index.js: the one rule evaluator the gateway decides stage rules with (records' defineRule `require` expressions). Parsed and evaluated here,
// never handed to eval; limits on length, depth and nodes. Records re-exports it (records/language/expr.js), so a rule judged at authoring time and a rule
// judged by the gateway are the same code.
import { parseExpr, evalExpr } from "../../lib/expr/expr.js";
export { parseExpr, evalExpr, exprNames } from "../../lib/expr/expr.js";
export { LanguageError } from "../../lib/expr/errors.js";
/** The object `createGateway({ expr })` takes; it is the gateway's default, so a consumer wires nothing. */
export const expr = Object.freeze({ parseExpr, evalExpr });
export { holds, isEmpty, fieldState, fieldStates, stagesFor, stageNamesOf, defaultEvaluator } from "../../lib/expr/conditions.js";
