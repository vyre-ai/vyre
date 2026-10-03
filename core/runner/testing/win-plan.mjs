// Windows debug: run the planned launcher against a plain folder (no encrypted volume) to separate env and pipe problems from volume problems.
import fs from "node:fs"; import path from "node:path";
import { plan, launch } from "../sandbox.js";
import { ensureLauncher, prepare } from "../sandbox-win.js";
const base = process.argv[2], ws = path.join(base, "work");
fs.mkdirSync(path.join(ws, "files"), { recursive: true });
const launcher = ensureLauncher(path.join(base, "bin"));
const node = process.execPath;
console.log(JSON.stringify(prepare({ launcher, space: "harlow", workspace: ws, readOnly: [path.dirname(node)] })));
const p = plan({ platform: "win32", space: "harlow", launcher, workspace: ws, command: node, args: ["-e", "console.log('hello from node in the container', process.cwd())"], readOnly: [path.dirname(node)], proxy: { port: 18443 }, env: {} });
console.log(p.argv.join(" | ")); console.log(JSON.stringify(p.env));
const c = launch(p, {}); c.stdout.on("data", d => console.log("out:", String(d).trim())); c.stderr.on("data", d => console.log("err:", String(d).trim())); c.on("close", code => { console.log("exit", code); process.exit(0); });
