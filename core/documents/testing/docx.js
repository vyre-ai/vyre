// @ts-check
// A minimal valid Word document built in code, so tests need no binary fixture. `runs` is one paragraph's runs, so a test can split a placeholder across runs the way Word does.
import PizZip from "pizzip";

const NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
/** @param {(string[] | string)[]} paragraphs each a string or a list of runs @returns {Buffer} */
export function docx(paragraphs) {
  const z = new PizZip();
  z.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  z.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  const body = paragraphs.map(p => `<w:p>${(Array.isArray(p) ? p : [p]).map(r => `<w:r><w:t xml:space="preserve">${r}</w:t></w:r>`).join("")}</w:p>`).join("");
  z.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${NS}"><w:body>${body}</w:body></w:document>`);
  return z.generate({ type: "nodebuffer" });
}

/** The text of a .docx, paragraph by paragraph. @param {Buffer} buf @returns {string[]} */
export function textOf(buf) {
  const xml = String(new PizZip(buf).file("word/document.xml").asText());
  return [...xml.matchAll(/<w:p[ >].*?<\/w:p>/gs)].map(m => m[0].replace(/<[^>]+>/g, ""));
}
