# forms

A public form that files each answer as a lead. Written against the public SDK only.

| Tool | Reach | What it shows |
|---|---|---|
| `forms.submit` | hook | `needs.kernel.records`: makes `lead` records in your Space; reached only by the form's webhook route |
| `forms.leads` | anyone | reads the leads back through the same declared verb |

The install card says "makes, reads and changes lead records, as you". The module cannot define a type, remove a record, or touch any other type; the Space must already have a `lead` type (a Kit or a person defines it).

```console
$ node --test                 # forms.test.js, on the SDK's testing harness
$ vyre module test .          # conformance, then the tests
$ vyre module add .
```

`public/form.html` is the page people fill in; serve it from a published site that posts to the form's webhook route.
