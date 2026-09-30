// @ts-check
// duty: a teammate's standing duty, written as an ordinary watcher folder.
//
// There is one runner and one code writer. The duty's own code is a fixed template, reviewed once
// here, never text a model wrote: it reads the instruction from watcher.json and files one item per
// firing, so what a duty did is visible in watchers.items like any watcher's. Model judgment
// (`ask`) is used when the runtime hands it over and skipped when it does not.

export const DUTY_NAME = /^duty-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const DUTY_WATCH_JS = `// A teammate's standing duty. The code is fixed; the instruction and trigger live in watcher.json.
import { readFileSync } from "node:fs";

export default async function watch({ hook, emit, log }) {
  const spec = JSON.parse(readFileSync(new URL("./watcher.json", import.meta.url), "utf8"));
  const why = hook && hook.event ? hook.event : "its schedule";
  const key = hook && (hook.id || hook.thread || hook.session || hook.item) ? String(hook.id || hook.thread || hook.session || hook.item) : new Date().toISOString().slice(0, 16);
  log("fired on", why);
  emit({ id: spec.name + ":" + key, title: spec.instruction.split("\\n")[0].slice(0, 200), about: spec.owner.teammate,
    why, act: spec.act === true, at: Date.now() });
}
`;
