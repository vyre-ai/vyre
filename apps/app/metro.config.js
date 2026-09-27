// Metro for the one app (ADR 0027). Expo's defaults, plus two folders of shared code from the
// repo, so the app runs the same code as the Deck with one copy of each:
//   - `@vyre/resilience/<file>` is ../../core/resilience/<file>: the box's stream and outbox (ADR 0029).
//   - `@vyre/chat-core/<file>` is ../../deck/chat/core/<file>: chat's session core (the transcript
//     model, pacing, windowing, the composer's rules, tool detail), imported as it is (ADR 0027, section 2).
// Only those folders are watched, not the whole repo. tsconfig.json has the same paths.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { getDefaultConfig } = require("expo/metro-config");

const here = path.dirname(fileURLToPath(import.meta.url));
const ALIASES = [
  { prefix: "@vyre/resilience/", dir: path.resolve(here, "../../core/resilience") },
  { prefix: "@vyre/chat-core/", dir: path.resolve(here, "../../deck/chat/core") },
];

const config = getDefaultConfig(here);
config.watchFolders = [...(config.watchFolders ?? []), ...ALIASES.map((a) => a.dir)];

const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, name, platform) => {
  for (const { prefix, dir } of ALIASES) {
    if (!name.startsWith(prefix)) continue;
    const file = path.join(dir, name.slice(prefix.length));
    if (!file.startsWith(dir + path.sep)) throw new Error(`${name} is outside ${path.relative(here, dir)}`);
    return { type: "sourceFile", filePath: file };
  }
  // A file inside a shared folder importing its neighbour ("./tool-detail.js") resolves as usual.
  return (upstream ?? context.resolveRequest)(context, name, platform);
};

export default config;
