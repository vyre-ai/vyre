// The sample build's answers for the Documents tools the record page uses (documents.template.list and .get, documents.generate, documents.send, documents.signing.waiting and .remind), so the
// Documents bar is there on a sample record. Two Word templates and one request waiting for a signature (Dana Reyes, the sample client).
const TEMPLATES: Record<string, string[]> = { "Engagement letter": ["contact.name", "contact.email", "brand.name"], Will: ["contact.name", "project.title"] };

export const mockDocumentTools: Record<string, (i: any) => unknown> = {
  "documents.template.list": () => ({ templates: Object.keys(TEMPLATES).map((name) => ({ name, size: 18_400 })) }),
  "documents.template.get": (i) => ({ name: String(i.name), version: 1, placeholders: TEMPLATES[String(i.name)] ?? [], loops: [] }),
  "documents.generate": (i) => ({ path: `Documents/general/${String(i.template).toLowerCase().replace(/[^a-z0-9]+/g, "-")}-3f9a1c2e.${i.format === "pdf" ? "pdf" : "docx"}`, format: i.format === "pdf" ? "pdf" : "docx", template: String(i.template) }),
  "documents.send": () => ({ submission: 77 }),
  "documents.signing.waiting": () => ({ requests: [{ submission: 41, signer: "Dana Reyes", email: "dana.reyes@example.com", template: "Engagement letter", at: Date.now() - 5 * 3_600_000 }] }),
  "documents.signing.remind": () => ({ submission: 41 }),
};
