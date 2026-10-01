#!/bin/bash
# The macOS watcher profile against the real runner, on a hosted macOS runner: the profile the product
# builds (lib/sandbox/wall.js macProfile), node's own runner under it, and the sandbox's denials from the
# system log, so a profile that is too tight can be loosened by what it actually needed.
set -uo pipefail
[ "${GITHUB_ACTIONS:-}" = "true" ] || { echo "runs on a hosted runner only"; exit 2; }
W=$(cd "$(mktemp -d)" && pwd -P); cp core/watchers/runner.js "$W/runner.js"
cat > "$W/watch.js" <<'JS'
import fs from "node:fs";
export default async function watch({ emit, log }) { log("x"); emit({ id: "1", title: String(fs.readFileSync(new URL("./watch.js", import.meta.url), "utf8").length) }); }
JS
echo '{"name":"t","project":"p","schedule":"*/15 * * * *"}' > "$W/watcher.json"
NODE=$(node -p 'require("fs").realpathSync(process.execPath)')
node --input-type=module -e '
import { macProfile } from "./lib/sandbox/wall.js";
import fs from "node:fs"; import path from "node:path";
const [w, node] = process.argv.slice(1);
fs.writeFileSync("/private/tmp/watch.sb", macProfile([w, node, path.dirname(node)], { node }));
' "$W" "$NODE"
echo "=== profile"; cat /private/tmp/watch.sb; echo
START=$(date -u +"%Y-%m-%d %H:%M:%S")
printf '{"t":"run","entry":"file://%s/watch.js","since":null,"hook":null}\n' "$W" | sandbox-exec -f /private/tmp/watch.sb "$NODE" --permission "--allow-fs-read=$W" "--allow-fs-read=$W/runner.js" "$W/runner.js"
echo "=== exit $?"
echo "=== sandbox denials since $START"
log show --start "$START" --style compact --predicate 'eventMessage CONTAINS "deny(" AND eventMessage CONTAINS "Sandbox"' 2>&1 | head -80 || true
# rerun marker: 1dbed8c3
