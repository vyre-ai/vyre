#!/bin/bash
# Records what node needs from the macOS sandbox, so the watcher profile can be a deny-default
# allowlist (`(trace ...)` writes the operations a process performs). Runs on a hosted macOS runner only.
set -euo pipefail
[ "${GITHUB_ACTIONS:-}" = "true" ] || { echo "runs on a hosted runner only"; exit 2; }
W=$(cd "$(mktemp -d)" && pwd -P); cp core/watchers/runner.js "$W/runner.js"
cat > "$W/watch.js" <<'JS'
import fs from "node:fs";
export default async function watch({ emit, log }) { log("x"); emit({ id: "1", title: fs.readFileSync(new URL("./watch.js", import.meta.url), "utf8").length }); }
JS
cat > "$W/watcher.json" <<'JS'
{"name":"t","project":"p","schedule":"*/15 * * * *"}
JS
NODE=$(node -p 'process.execPath')
TRACE=/private/tmp/node.trace; rm -f $TRACE
printf '(version 1)\n(trace "%s")\n(allow default)\n' "$TRACE" > /private/tmp/trace.sb
printf '{"t":"run","entry":"file://%s/watch.js","since":null,"hook":null}\n' "$W" | sandbox-exec -f /private/tmp/trace.sb "$NODE" --permission "--allow-fs-read=$W" "--allow-fs-read=$W/runner.js" "$W/runner.js" || true
echo "=== trace (unique operations)"; ls -la /private/tmp | head; sort -u $TRACE | head -400
echo "=== probes that must be denied by deny-default, for reference"
