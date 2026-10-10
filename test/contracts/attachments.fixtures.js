// @ts-check
// Fixtures for team/contracts/attachments.md. agent-core builds the provider adapters against these while chat builds the box's tools; lib/attachments.js (real today) is checked against them by
// test/contracts/attachments.test.js. The bytes are tiny and real: a PNG that decodes, a PDF header, a short text.

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n").toString("base64");
const TEXT = Buffer.from("Dana Reyes accepts 250,000.\n").toString("base64");

export const attachmentFixtures = {
  image: { id: "att_Zk3pQ9wL2mTxV8aB", name: "screenshot.png", mime: "image/png", bytes: 68, base64: PNG_1PX },
  pdf: { id: "att_Hq7nR4sD1yUeC6jM", name: "offer letter.pdf", mime: "application/pdf", bytes: 46, base64: PDF },
  text: { id: "att_Lw5vG0tF8oIxN2kP", name: "notes.txt", mime: "text/plain", bytes: 28, base64: TEXT },
  sheet: { id: "att_Bd9eS3cA6hYzJ1qW", name: "ledger.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: 20_480, base64: "" },
};

/** What a message carries: the four fields and nothing else. @param {...keyof typeof attachmentFixtures} names */
export const onMessage = (...names) => names.map(n => { const { id, name, mime, bytes } = attachmentFixtures[n]; return { id, name, mime, bytes }; });

/** The box's attachments.open, as a fake: base64 or a path for a fixture id. @param {string} cwd */
export const fakeOpen = cwd => async (/** @type {string} */ id, /** @type {"base64" | "path"} */ as) => {
  const f = Object.values(attachmentFixtures).find(x => x.id === id);
  if (!f) throw Object.assign(new Error("no such file in this chat"), { code: "not_found" });
  return as === "base64" ? { base64: f.base64 } : { path: `${cwd}/.vyre/attachments/${f.id}-${f.name}` };
};

/** The form each fixture reaches the model in: an image inline, anything else as a file in the session's folder. */
export const formsExpected = { image: "image", pdf: "path", text: "path", sheet: "path" };
