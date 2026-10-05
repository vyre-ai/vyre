// lib/id.js: where new ids come from. A time-ordered uuid (48 bits of milliseconds first, then random), so text order is creation order and an id says when it was made.
// It carries the v4 version marker on purpose, not v7's: Twenty's store rejects v7 (kernel/core/ids.js), and Claude Code takes a session id of this shape. The `spc_` and `per_`
// prefixed ids stay as they are, and ids already stored are never rewritten.
import { mintUuid, mintId, isUuid, timeOf } from "../kernel/core/ids.js";

export { mintUuid as newId, mintId as newPrefixedId, isUuid, timeOf };
