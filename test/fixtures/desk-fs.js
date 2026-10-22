// One file operation for an agent's folder, on a temp home the test names. The real serveFs checks the path.
import fs from "node:fs";
import path from "node:path";
import { serveFs } from "../../core/computers/image/agentd-fs.js";

const root = process.env.DESK_FS_ROOT || "";
const uid = process.env.DESK_UID || "";
const home = path.join(root, `ag${uid}`);
fs.mkdirSync(home, { recursive: true });
await serveFs({ root: home, input: process.stdin, output: process.stdout });
process.exit(0);
