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
  const title = spec.instruction.split("\\n")[0].slice(0, 200);
  log("fired on", why);
  // A push names a batch of messages by id: one item per id, so each is filed once. Nothing else
  // from the push is kept here (no sender, no subject): the content is read later, on purpose.
  const ids = hook && Array.isArray(hook.ids) ? hook.ids.map(String).slice(0, 25) : [];
  const one = hook && (hook.id || hook.thread || hook.session || hook.item);
  const keys = ids.length ? ids : [one ? String(one) : new Date().toISOString().slice(0, 16)];
  for (const key of keys) emit({ id: spec.name + ":" + key.slice(0, 120), title, about: spec.owner.teammate, why, act: spec.act === true, at: Date.now() });
}
`;
