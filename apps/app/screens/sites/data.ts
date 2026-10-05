// Sites and apps: sample data. `sitesRepo` is where the real publisher plugs in.
import type { SpaceId } from "../places/scope";

export type Dep = { v: string; st: "live" | "preview" | "old"; by: string; when: string; msg: string; pipe: ("done" | "cur" | "")[] };
export type Site = {
  id: string; name: string; type: "App" | "Site"; sp: SpaceId; src: [string, string, string]; dom: { name: string; ok: boolean };
  sec: Record<string, boolean>; dep: Dep[]; logs: { build: string[]; run: string[] };
};

const done: Dep["pipe"] = ["done", "done", "done", "done", "done"];

export const sitesRepo = {
  sites(): Site[] {
    return [
      { id: "intake", name: "Client intake form", type: "App", sp: "harlow", src: ["GitHub repo", "harlow-legal/intake-form", "branch main"], dom: { name: "intake.harlowlegal.com", ok: true }, sec: { "Stripe (read only)": true, Clio: false, Gmail: false },
        dep: [{ v: "v13", st: "preview", by: "kit", when: "14 min ago", msg: "Fix the phone field label", pipe: ["done", "done", "done", "cur", ""] }, { v: "v12", st: "live", by: "chris", when: "3 days ago", msg: "Add the consent checkbox", pipe: done }, { v: "v11", st: "old", by: "kit", when: "8 days ago", msg: "Split the name field", pipe: done }],
        logs: { build: ["09:00:02  fetch harlow-legal/intake-form@a41f7c2", "09:00:09  install 214 packages", "09:00:31  build ok, 38 files, 412 KB", "09:00:33  preview ready at intake-7f3a.preview.vyre.run"], run: ["09:12:40  GET /  200  41 ms", "09:12:44  POST /submit  200  118 ms", "09:13:02  submit sent to Harlow Legal intake, matter opened"] } },
      { id: "site", name: "harlowlegal.com", type: "Site", sp: "harlow", src: ["Drive folder", "Harlow Legal / Website", "synced 2 min ago"], dom: { name: "harlowlegal.com", ok: false }, sec: { "Stripe (read only)": false, Clio: false, Gmail: false },
        dep: [{ v: "v8", st: "live", by: "chris", when: "3 Sep", msg: "New team page", pipe: done }, { v: "v7", st: "old", by: "chris", when: "28 Aug", msg: "Update hours", pipe: done }],
        logs: { build: ["08:20:11  read Drive folder Harlow Legal / Website", "08:20:14  38 pages, 2 images", "08:20:20  build ok"], run: ["Today  412 visits, 0 errors"] } },
      { id: "pricing", name: "Pricing explorer", type: "App", sp: "harlow", src: ["Assistant artifact", "kit: Pricing explorer, Tue", "artifact"], dom: { name: "pricing.harlowlegal.vyre.run", ok: true }, sec: { "Stripe (read only)": false, Clio: false, Gmail: false },
        dep: [{ v: "v2", st: "preview", by: "kit", when: "2 h ago", msg: "Add the fee schedule B table", pipe: ["done", "done", "cur", "", ""] }, { v: "v1", st: "live", by: "kit", when: "Tue", msg: "First version", pipe: done }],
        logs: { build: ["07:02:40  package artifact from kit", "07:02:44  build ok, 6 files"], run: ["Today  23 visits, 0 errors"] } },
    ];
  },
  previewUrl(s: Site): string {
    return `${s.id === "intake" ? "intake-7f3a" : `${s.id}-91c2`}.preview.vyre.run`;
  },
  checksLine(passed: boolean): string {
    return passed ? "Checks: 12 of 12 passed (forms submit, mobile layout, page speed, no secrets in the page)." : "Checks are running.";
  },
};
