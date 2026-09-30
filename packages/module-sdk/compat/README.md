# Module contract adapters

One file per contract major a Vyre still supports, next to the running one (ADR 0047 section 8).

- `v1.js` serves `"vyre": "1"` modules. Today contract 1 is current, so it is the identity: the
  manifest and the ctx pass through unchanged. The loader and `@vyre/module-sdk/testing` already
  route every v1 module through it, and a test proves the seam is used.
- When contract 2 ships, `v1.js` becomes the real adapter. It translates a v1 manifest onto v2 and
  gives the module the v1 ctx it was written against, built on the v2 one, so the module runs
  unchanged. `v2.js` is then the identity. Conformance runs every v1 example and pinned fixture
  through the adapter.
- A major stays supported for at least 12 months after the next one's first release. When its
  adapter is removed, the module's row says "needs the v1 adapter, removed in Vyre X: run vyre
  module upgrade", and it is never imported.

`contract.js` picks the adapter with `adapterFor(vyre)`.
