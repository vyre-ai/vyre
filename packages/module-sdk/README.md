# @vyre/module-sdk

Everything an outside author needs to write a Vyre module against module API 1
([ADR 0047](../../docs/adr/0047-module-contract-v1.md), which finalizes
[ADR 0033](../../docs/adr/0033-hackable-vyre.md)):

- `index.d.ts`: the manifest and the `ctx` a module's `start(ctx)` receives. Members tagged
  `@internal` are for Vyre's own modules, are absent in the module host, and may change in any
  release. Members tagged `@planned` are part of module API 1 but not built in vyred yet; test for
  them with `ctx.api.has()`. Members tagged `@deprecated` work through 0.3.
- `manifest.schema.json` (`https://vyre.run/schema/module-1.json`): the one definition of
  `module.json`. Point your manifest's `$schema` at it for editor help.
- `manifest.js`: `checkManifest(manifest)` returns a list of problems, empty when the manifest is
  valid for an added module (`{ firstParty: true }` for Vyre's own). `toolEntries(manifest)` gives
  every tool as `{ name, summary, reach, outward, cost }`. `capabilities(manifest)` is the install
  card, computed from the manifest alone, and `widened(before, after)` lists what an update adds.
- `testing.js` (`@vyre/module-sdk/testing`): `testModule(dir)` starts a module over a temp home
  with a fake registry, Gate, vault, spend and push, and no daemon.
- `conform.js` (`@vyre/module-sdk/conform`): `conformModule(dir)` runs the checks every module must
  pass. `vyre module test` runs it, then the module's own tests.

Every tool says who may call it and whether it acts as the person outside:

```json
"does": { "tools": [
  { "name": "bakery.orders", "summary": "list today's orders" },
  { "name": "bakery.target", "summary": "change the daily target", "reach": "asked" },
  { "name": "bakery.flour", "summary": "order flour from the supplier", "outward": "pay" }
] }
```

```js
// @ts-check
/** @type {import("@vyre/module-sdk").Module} */
export default {
  async start(ctx) {
    ctx.tool("bakery.orders", {
      description: "Today's Northwind Bakery orders",
      input: { type: "object", properties: {} },
      examples: [{ input: {} }],
      run: async () => ({ count: 12 }),
    });
    return { async stop() {} };
  },
};
```

The package isn't on npm yet: it publishes with Vyre's first npm release. Until then, reference it
from a checkout of the Vyre repo. `vyre module check` runs `checkManifest()` from the CLI, and
`vyre module new` scaffolds a module that passes it and `conformModule()`. Hand another agent
[docs/build/AGENT-BRIEF.md](../../docs/build/AGENT-BRIEF.md) and it has everything it needs.
