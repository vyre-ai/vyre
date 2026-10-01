// @ts-check
// The sample site the docs world (deck/test/world.js) seeds for the Sites tab: a fictional CRM, "Harlow CRM", with a family, a few
// controls, a flow that has run and one thing that used to work. Sample-world names only. The seed talks to the store through the
// same tools Chrome and the person use (memory.site.put and memory.site.report), so what it shows is what the store keeps.

export const SAMPLE_ORIGIN = "https://app.harlowcrm.example";

/**
 * @param {{ cli: (tool: string, input: any) => Promise<any>, at: (ms: number) => void, now: number }} o
 *   at: sets the store's clock (its test clock), so misses can be put on earlier days.
 */
export async function seedSites({ cli, at, now }) {
  const DAY = 86_400_000, HOUR = 3_600_000;
  const origin = SAMPLE_ORIGIN;
  const visits = ["v1", "v2"];
  at(now - 6 * DAY);
  await cli("memory.site.put", { origin, patch: { names: ["Harlow CRM"], family: "harlowcrm", ready: [{ kind: "landmark", arg: "nav" }],
    login: { wall: [{ kind: "password-field" }], authHosts: ["login.harlowcrm.example"] },
    controls: [
      { id: "c1", page: "/contacts", role: "button", container: "main", siblings: 1, name: "Add contact", nameVisits: visits, identifierVisits: visits, selector: { strategy: "identifier", identifier: "add-contact" } },
      { id: "c2", page: "/contacts", role: "tab", container: "tablist", siblings: 1, name: "Pipeline", nameVisits: visits, identifierVisits: visits, selector: { strategy: "identifier", identifier: "tab-pipeline" } },
      { id: "c3", page: "/settings", role: "button", container: "main", siblings: 1, name: "Export", nameVisits: visits, identifierVisits: visits, selector: { strategy: "identifier", identifier: "export-all" } },
    ] } });
  await cli("memory.site.put", { origin, target: "family", patch: {
    api: [{ id: "e_1", method: "GET", origin: "https://api.harlowcrm.example", pathTemplate: "/contacts", query: { limit: "number" }, authKind: "bearer", statuses: [200], count: 12 },
      { id: "e_2", method: "POST", origin: "https://api.harlowcrm.example", pathTemplate: "/contacts", query: {}, bodyShape: { name: "string", source: "string" }, authKind: "bearer", statuses: [201], count: 4 }],
    flows: [{ name: "add-lead", title: "Add a lead", src: "learned", runs: 6, fails: 1, expects: [{ kind: "selector", arg: "toast" }], params: [{ name: "name", type: "string" }],
      steps: [{ id: "s1", op: "page.act", args: { control: "c1" } }, { id: "s2", op: "page.fill", args: { field: "c2", value: "{name}" } }] }] } });
  // The export button moved: three misses over three days set it aside ("used to work").
  const miss = () => cli("memory.site.report", { origin, part: "controls", id: "c3", outcome: "miss" });
  await miss(); at(now - 6 * DAY + 2 * HOUR); await miss(); at(now - 3 * DAY); await miss();
  // The rest worked lately.
  at(now - 2 * HOUR);
  for (const id of ["c1", "c2"]) await cli("memory.site.report", { origin, part: "controls", id, outcome: "ok" });
}
