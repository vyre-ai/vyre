// Metro for the one app (ADR 0027). Expo's defaults, plus four folders of shared code from the
// repo, so the app runs the same code as the Deck with one copy of each:
//   - `@vyre/resilience/<file>` is ../../core/resilience/<file>: the box's stream and outbox (ADR 0029).
//   - `@vyre/chat-core/<file>` is ../../deck/chat/core/<file>: chat's session core (the transcript
//     model, pacing, windowing, the composer's rules, tool detail), imported as it is (ADR 0027, section 2).
//   - `@vyre/relay-client/<file>` is ../../relay/client/<file>: pairing and the relay path (ADR 0026).
//   - `@vyre/ui` is ./ui, the one UI package (NativeWind + react-native-reusables); `@vyre/deck-ui/<file>` is ../../deck/ui, the
//     DOM-free half of the first UI build (the store, the mock store, the task and type models), and `@vyre/kernel/<file>` is
//     ../../kernel/contracts. Those two are shared as they are, so there is one copy of the domain, not two.
//   - `@vyre/stream/<file>` is ../../core/stream/<file>: the session stream's resumable client and frame shapes (ADR 0052).
//   - `@vyre/perf/<file>` is ../../lib/perf/<file>: the DOM-free frame meter and its BAR, shared with
//     the Deck's native-bar harness.
// Only those folders are watched, not the whole repo. tsconfig.json has the same paths.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const here = path.dirname(fileURLToPath(import.meta.url));
const ALIASES = [
  { prefix: "@vyre/resilience/", dir: path.resolve(here, "../../core/resilience") },
  { prefix: "@vyre/chat-core/", dir: path.resolve(here, "../../deck/chat/core") },
  { prefix: "@vyre/relay-client/", dir: path.resolve(here, "../../relay/client") },
  { prefix: "@vyre/stream/", dir: path.resolve(here, "../../core/stream") },
  { prefix: "@vyre/perf/", dir: path.resolve(here, "../../lib/perf") },
  { prefix: "@vyre/deck-ui/", dir: path.resolve(here, "../../deck/ui") },
  { prefix: "@vyre/kernel/", dir: path.resolve(here, "../../kernel/contracts") },
];
// Folders the shared files import by relative path (deck/ui reaches ../../kernel/contracts and ../../lib/theme).
// ui/views/logic reaches the shared expression rules (lib/expr, one copy for the kernel and the app).
// ui/marks reaches the Deck's mark generators (deck/vendor/vyrecode) and the seed rule (lib/avatar-seed) by relative path.
const EXTRA_WATCH = [path.resolve(here, "../../kernel/identity"), path.resolve(here, "../../names/worker"), path.resolve(here, "../../kernel/contracts"), path.resolve(here, "../../lib/theme"), path.resolve(here, "../../deck/vendor/vyrecode"), path.resolve(here, "../../deck/vyrecode"), path.resolve(here, "../../deck/js"), path.resolve(here, "../../lib/avatar-seed"), path.resolve(here, "../../lib/wink-code"), path.resolve(here, "../../lib/expr")];

const config = getDefaultConfig(here);
config.watchFolders = [...(config.watchFolders ?? []), ...ALIASES.map((a) => a.dir), ...EXTRA_WATCH];
// The web build's fonts are woff2 (src/theme/fonts.web.ts); the native builds embed the ttf files.
if (!config.resolver.assetExts.includes("woff2")) config.resolver.assetExts.push("woff2");

const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, name, platform) => {
  if (name === "@vyre/ui") return (upstream ?? context.resolveRequest)(context, path.join(here, "ui/index.ts"), platform);
  if (name.startsWith("@vyre/ui/")) return (upstream ?? context.resolveRequest)(context, path.join(here, "ui", name.slice(9)), platform);
  for (const { prefix, dir } of ALIASES) {
    if (!name.startsWith(prefix)) continue;
    const file = path.join(dir, name.slice(prefix.length));
    if (!file.startsWith(dir + path.sep)) throw new Error(`${name} is outside ${path.relative(here, dir)}`);
    return { type: "sourceFile", filePath: file };
  }
  // A file inside a shared folder importing its neighbour ("./tool-detail.js") resolves as usual.
  return (upstream ?? context.resolveRequest)(context, name, platform);
};

export default withNativeWind(config, { input: "./global.css" });
