// Metro for the one app (ADR 0027). Expo's defaults, plus the box's resilience code
// (core/resilience, ADR 0029) from the repo, so the app runs the same stream and outbox as the
// Deck. Only that folder is watched, not the whole repo. `@vyre/resilience/<file>` is an alias
// for ../../core/resilience/<file>; tsconfig.json has the same path.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { getDefaultConfig } = require("expo/metro-config");

const here = path.dirname(fileURLToPath(import.meta.url));
const resilience = path.resolve(here, "../../core/resilience");
const PREFIX = "@vyre/resilience/";

const config = getDefaultConfig(here);
config.watchFolders = [...(config.watchFolders ?? []), resilience];

const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, name, platform) => {
  if (name.startsWith(PREFIX)) {
    const file = path.join(resilience, name.slice(PREFIX.length));
    if (!file.startsWith(resilience + path.sep)) throw new Error(`${name} is outside core/resilience`);
    return { type: "sourceFile", filePath: file };
  }
  return (upstream ?? context.resolveRequest)(context, name, platform);
};

export default config;
