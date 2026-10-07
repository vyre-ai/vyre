// Vault's sample data. The secrets are made-up values for the sample world; a real source returns them only to a person who passed Face ID,
// and never to an assistant. `vaultRepo` is where that source plugs in.
import type { SpaceId } from "../places/scope";

export type Right = "use" | "fill" | "copy";
export type Item = {
  id: string; sp: SpaceId; kind: "Login" | "Key" | "Card"; name: string; user: string; secret: string;
  use: { who: string; for: string; times: number; note: string }[];
  grants: { who: string; right: Right }[];
};
export type Held = { id: string; sp: SpaceId; title: string; field: string; value: string };

/** Who can be given a credential. */
export const PEOPLE = ["kit", "juno", "chris", "iris"];

export const vaultRepo = {
  items(): Item[] {
    return [
      { id: "v1", sp: "juniper", kind: "Login", name: "Gmail", user: "intake@juniperstudio.example.com", secret: "Mt7!hQ2-sail-9Rb", use: [{ who: "kit", for: "Gmail", times: 3, note: "Today 9:12, send waiting for approval" }, { who: "juno", for: "Gmail", times: 1, note: "Today 8:40, read intake mail" }], grants: [{ who: "kit", right: "use" }, { who: "juno", right: "use" }, { who: "chris", right: "fill" }] },
      { id: "v2", sp: "juniper", kind: "Login", name: "Clio", user: "alex@juniperstudio.example.com", secret: "clio-4Gp-Lm81-Zq", use: [{ who: "kit", for: "Clio", times: 2, note: "Yesterday, matter export" }], grants: [{ who: "kit", right: "use" }] },
      { id: "v3", sp: "juniper", kind: "Key", name: "Stripe (read only)", user: "API key", secret: "rk_live_51Hx9Qa2d7uPz", use: [{ who: "kit", for: "Stripe", times: 5, note: "Today, payment lookups" }], grants: [{ who: "kit", right: "use" }] },
      { id: "v4", sp: "juniper", kind: "Card", name: "Firm Visa", user: "Visa ending 4242", secret: "4242 4242 4242 4242", use: [{ who: "iris", for: "Supplier invoice", times: 1, note: "2 min ago, $320, waiting on you" }], grants: [{ who: "iris", right: "use" }] },
      { id: "v5", sp: "mine", kind: "Login", name: "Passport portal", user: "alex.rivera", secret: "Pp-7731-bluff-Tn", use: [{ who: "juno", for: "Passport portal", times: 2, note: "Today, form checked" }], grants: [{ who: "juno", right: "use" }] },
      { id: "v6", sp: "mine", kind: "Login", name: "Airline account", user: "alex@example.com", secret: "Fly-93k-Zorro-p", use: [], grants: [] },
      { id: "v7", sp: "mine", kind: "Card", name: "Personal Visa", user: "Visa ending 1881", secret: "4111 1111 1111 1881", use: [], grants: [] },
    ];
  },
  /** Sealed fields on records. The Vault holds them; assistants see "<Label> on file, sealed". */
  held(): Held[] {
    return [
      { id: "h1", sp: "juniper", title: "Jane Doe", field: "Date of birth", value: "1958-03-14" },
      { id: "h2", sp: "juniper", title: "Jane Doe", field: "SSN", value: "000-12-3456" },
      { id: "h3", sp: "juniper", title: "Jane Doe", field: "Account number", value: "0099 8877 6655" },
      { id: "h4", sp: "mine", title: "Alex Rivera", field: "Passport number", value: "X0000000" },
    ];
  },
};
