# bakery

The complete example of module API 1 ([ADR 0047](../../../docs/adr/0047-module-contract-v1.md)):
Northwind Bakery's orders, the daily target and the flour order.

| Tool | Reach | What it shows |
|---|---|---|
| `bakery.orders` | anyone | a store table, a CLI verb (`vyre bakery orders`) |
| `bakery.add` | anyone | an event, a memory note for orders of 20 or more, a push when the target is reached |
| `bakery.target` | asked | a setting and an undo entry; an agent calls it only when the person asked |
| `bakery.flour` | anyone, outward pay | a vendor API call with a key the module never sees; held at the Gate unless the person asked |
| `bakery.today` | anyone | the Now card (`shows.deck: now:bakery.today`) |

`watchers/big-order.json` is a watcher preset: it describes, and runs no code.

```console
$ node --test                 # bakery.test.js, on the SDK's testing harness
$ vyre module test .          # conformance, then the tests
$ vyre module add .
```
