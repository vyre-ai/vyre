# docgen

A template plus a record gives a file in your Drive. Written against the public SDK only.

| Tool | Reach | What it shows |
|---|---|---|
| `docgen.make` | anyone | `needs.kernel.records` reads a `doc_template` and a `contact`; `needs.kernel.files` writes into `Clients/` only |

The install card says "makes, reads and changes doc_template, contact records, as you" and "writes files in Clients in your Drive". It cannot write outside `Clients/`, cannot define a type, and sees sealed fields only as placeholders, so a document never carries a value the module was not allowed to read.

```console
$ node --test                 # docgen.test.js, on the SDK's testing harness
$ vyre module test .          # conformance, then the tests
$ vyre module add .
```
